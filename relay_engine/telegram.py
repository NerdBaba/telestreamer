"""Local MTProto publishing using an existing, authorized Telethon session.

RTMP credentials are returned only to the caller and are never logged here.
Private invite hashes are opaque; resolving a target never joins any chat.
Native broadcast chunks are not ordinary HLS segments: see Telegram's
/api/group-calls#downloading-media-chunks and tgcalls VideoStreamingPart.cpp.
"""
from __future__ import annotations

import asyncio
from pathlib import Path
from urllib.parse import parse_qs, urlsplit


class TelegramAccessError(RuntimeError):
    """The local session cannot safely access or publish to the target."""


def _invite_hash(value: str) -> str | None:
    value = value.strip()
    if value.startswith("+"):
        return value[1:]
    parsed = urlsplit(value if "://" in value else "https://" + value)
    if parsed.scheme == "tg" and parsed.netloc == "join":
        return parse_qs(parsed.query).get("invite", [""])[0]
    if parsed.hostname in {"t.me", "telegram.me", "telegram.dog", "www.t.me"}:
        path = parsed.path.strip("/")
        if path.startswith("+"):
            return path[1:]
        if path.startswith("joinchat/"):
            return path.split("/", 1)[1]
    return None


def require_manage_call(entity) -> None:
    """Rights belong to Channel, not the messages.ChatFull wrapper."""
    if getattr(entity, "left", False):
        raise TelegramAccessError("The authorized account is not a member of the target channel.")
    rights = getattr(entity, "admin_rights", None)
    if not (getattr(entity, "creator", False) or getattr(rights, "manage_call", False)):
        raise TelegramAccessError("The target requires creator or manage_call administrator rights.")


async def _full_channel(client, entity):
    from telethon.tl.functions.channels import GetFullChannelRequest
    from telethon.tl.types import Channel

    if not isinstance(entity, Channel):
        raise TelegramAccessError("The target must be a Telegram channel or supergroup.")
    full = await client(GetFullChannelRequest(entity))
    # The full response also contains the current Channel, including its rights.
    entity = next((chat for chat in full.chats if chat.id == entity.id), entity)
    return entity, full


async def resolve_channel(client, target: str):
    """Resolve an existing membership without decoding hashes or joining chats.

    For expired invites, dialogues are usable only when a channel's exported
    invite matches the exact hash. Titles cannot identify an invite's channel.
    A numeric channel id may instead be supplied when the session knows it.
    """
    from telethon.errors import (
        ChannelPrivateError, InviteHashEmptyError, InviteHashExpiredError,
        InviteHashInvalidError, UsernameInvalidError, UsernameNotOccupiedError,
    )
    from telethon.tl.functions.messages import CheckChatInviteRequest
    from telethon.tl.types import Channel, ChatInviteAlready

    value = target.strip()
    if not value:
        raise TelegramAccessError("A Telegram target channel is required.")
    invite = _invite_hash(value)
    if invite is not None:
        if not invite:
            raise TelegramAccessError("The private invite link has an empty hash.")
        try:
            result = await client(CheckChatInviteRequest(invite))
        except (ChannelPrivateError, InviteHashEmptyError, InviteHashExpiredError,
                InviteHashInvalidError):
            async for dialogue in client.iter_dialogs():
                entity = dialogue.entity
                if not isinstance(entity, Channel):
                    continue
                rights = getattr(entity, "admin_rights", None)
                if not (getattr(entity, "creator", False) or getattr(rights, "manage_call", False)):
                    continue
                try:
                    entity, full = await _full_channel(client, entity)
                except ChannelPrivateError:
                    continue
                exported = getattr(full.full_chat, "exported_invite", None)
                if _invite_hash(getattr(exported, "link", "")) == invite:
                    return entity, full
            raise TelegramAccessError(
                "The invite is unavailable and cannot be matched to an existing dialogue. "
                "Supply the already-joined channel's numeric id or a current invite."
            ) from None
        if not isinstance(result, ChatInviteAlready):
            raise TelegramAccessError(
                "The authorized account has not joined the private target. "
                "Join the intended channel in Telegram first; no automatic join was attempted."
            )
        return await _full_channel(client, result.chat)

    parsed = urlsplit(value if "://" in value else "https://" + value)
    if parsed.hostname in {"t.me", "telegram.me", "telegram.dog", "www.t.me"}:
        value = parsed.path.strip("/")
    value = value.lstrip("@")
    lookup = int(value) if value.lstrip("-").isdigit() else value
    try:
        return await _full_channel(client, await client.get_entity(lookup))
    except (UsernameInvalidError, UsernameNotOccupiedError, ValueError):
        # A channel can be renamed, so a username is not a durable target.
        # A numeric id or an invite hash is. Fall back to the dialogs the
        # session already knows, matched by exact channel id.
        if not isinstance(lookup, int):
            raise
        async for dialogue in client.iter_dialogs():
            entity = dialogue.entity
            if isinstance(entity, Channel) and entity.id == lookup:
                return await _full_channel(client, entity)
        raise TelegramAccessError(
            f"The session is not a member of channel {lookup}; join it in Telegram first."
        ) from None


class TelegramPublisher:
    """Owns a local client and only calls explicitly created by this instance."""

    def __init__(self, api_id: int, api_hash: str, session: str, channel: str):
        if api_id <= 0 or not api_hash.strip():
            raise TelegramAccessError("Telegram API id and API hash are required.")
        self._api_id = api_id
        self._api_hash = api_hash
        self._session = session
        self._channel = channel
        self.client = None
        self._entity = None
        self._created_call = None
        self._destination_lock = asyncio.Lock()

    async def connect(self) -> None:
        if self.client is not None and self.client.is_connected() and self._entity is not None:
            return
        session_path = Path(self._session).expanduser()
        if not str(session_path).endswith(".session"):
            session_path = Path(str(session_path) + ".session")
        if not session_path.is_file():
            raise TelegramAccessError(
                "An existing authorized Telethon .session file is required. "
                "Run telegram_login.py locally first; the daemon never requests OTP or 2FA."
            )
        from telethon import TelegramClient

        self.client = TelegramClient(str(session_path), self._api_id, self._api_hash)
        try:
            await self.client.connect()
            if not await self.client.is_user_authorized():
                raise TelegramAccessError(
                    "The Telethon session is not authorized. Run telegram_login.py locally; "
                    "the daemon never requests OTP or 2FA."
                )
            me = await self.client.get_me()
            if me is None or getattr(me, "bot", False):
                raise TelegramAccessError("RTMP publishing requires an authorized Telegram user account.")
            self._entity, _ = await resolve_channel(self.client, self._channel)
            require_manage_call(self._entity)
        except BaseException:
            await self.client.disconnect()
            self.client = None
            self._entity = None
            raise

    def _require_connected(self) -> None:
        if self.client is None or not self.client.is_connected() or self._entity is None:
            raise TelegramAccessError("Connect the authorized Telegram publisher first.")

    async def destination(self) -> str:
        """Get genuine RTMP credentials and create a call only when none exists."""
        from telethon.tl.functions.phone import (
            CreateGroupCallRequest, GetGroupCallRequest, GetGroupCallStreamRtmpUrlRequest,
        )
        from telethon.tl.types import GroupCall, InputGroupCall, UpdateGroupCall

        self._require_connected()
        async with self._destination_lock:
            self._entity, full = await _full_channel(self.client, self._entity)
            require_manage_call(self._entity)
            call = getattr(full.full_chat, "call", None)
            if call is not None:
                current = (await self.client(GetGroupCallRequest(call, limit=1))).call
                if not isinstance(current, GroupCall) or not current.rtmp_stream:
                    raise TelegramAccessError(
                        "The target already has a non-RTMP or ended call; it will not be replaced."
                    )
                if current.schedule_date is not None:
                    raise TelegramAccessError("The existing RTMP call is scheduled, not started.")

            credentials = await self.client(GetGroupCallStreamRtmpUrlRequest(
                peer=self._entity, revoke=False,
            ))
            endpoint = urlsplit(credentials.url)
            if endpoint.scheme not in {"rtmp", "rtmps"} or not endpoint.hostname or not credentials.key:
                raise TelegramAccessError("Telegram did not return usable RTMP publishing credentials.")

            if call is None:
                result = await self.client(CreateGroupCallRequest(peer=self._entity, rtmp_stream=True))
                updates = getattr(result, "updates", None)
                if updates is None:
                    updates = [getattr(result, "update", None)]
                created = [
                    update.call for update in updates
                    if isinstance(update, UpdateGroupCall)
                    and isinstance(update.call, GroupCall)
                    and update.call.rtmp_stream
                    and not getattr(update, "live_story", False)
                    and (getattr(update, "peer", None) is None
                         or getattr(update.peer, "channel_id", None) == self._entity.id)
                ]
                if len(created) != 1:
                    raise TelegramAccessError(
                        "Telegram accepted call creation but returned no unique RTMP call identity; "
                        "inspect the target in Telegram before retrying."
                    )
                self._created_call = InputGroupCall(created[0].id, created[0].access_hash)
            return credentials.url.rstrip("/") + "/" + credentials.key

    async def announce(self, text: str) -> None:
        self._require_connected()
        await self.client.send_message(self._entity, text, parse_mode=None, link_preview=False)

    async def close(self, stop_call: bool = False) -> None:
        client = self.client
        if client is None:
            return
        try:
            if stop_call and self._created_call is not None and client.is_connected():
                from telethon.tl.functions.phone import DiscardGroupCallRequest

                await client(DiscardGroupCallRequest(self._created_call))
        finally:
            await client.disconnect()
            self.client = None
            self._entity = None
            self._created_call = None
