"""Discover every live broadcast the authorized session can see.

The relay used to pin one channel, which meant a new racing feed required a
redeploy. The session is already a member of several racing channels, so it can
enumerate all of them and report which are broadcasting right now.

Only the public Telethon surface is used: dialog call flags and, for chats
with a call, full chat and group-call metadata. Nothing is joined and no
message is posted.
"""

from __future__ import annotations

from dataclasses import dataclass, asdict


@dataclass(frozen=True)
class Broadcast:
    """One joined channel or group and its current call state."""
    chat_id: int
    title: str
    username: str | None
    live: bool = False
    rtmp: bool = False
    scheduled: bool = False


def _title(entity) -> str:
    return (getattr(entity, "title", None) or "").strip() or str(getattr(entity, "id", ""))


async def discover_broadcasts(client) -> list[dict]:
    """Every joined channel or group, with its broadcast state.

    Dialogs expose call_active, not a call object. Idle chats need no extra
    requests; only flagged calls are resolved through full metadata, just as
    the publisher resolves its destination. Call details distinguish scheduled
    calls from live ones and identify RTMP streams without joining anything.

    If a chat's metadata becomes inaccessible, retain its dialog call flag and
    continue discovering other chats. Flood waits must reach the caller so it
    can delay the next refresh instead of continuing to send requests.
    """
    from telethon.errors import FloodWaitError, RPCError
    from telethon.tl.functions.channels import GetFullChannelRequest
    from telethon.tl.functions.messages import GetFullChatRequest
    from telethon.tl.functions.phone import GetGroupCallRequest
    from telethon.tl.types import Channel, Chat, GroupCall

    found: list[dict] = []
    async for dialog in client.iter_dialogs():
        entity = dialog.entity
        if not isinstance(entity, (Channel, Chat)):
            continue
        if getattr(entity, "left", False) or getattr(entity, "deactivated", False):
            continue
        live = bool(entity.call_active)
        rtmp = scheduled = False
        if live:
            try:
                request = (
                    GetFullChannelRequest(entity)
                    if isinstance(entity, Channel)
                    else GetFullChatRequest(entity.id)
                )
                full = await client(request)
                call = full.full_chat.call
                if call is None:
                    live = False
                else:
                    current = (await client(GetGroupCallRequest(call, limit=1))).call
                    live = isinstance(current, GroupCall)
                    if live:
                        scheduled = current.schedule_date is not None
                        rtmp = bool(current.rtmp_stream)
                        live = not scheduled
            except FloodWaitError:
                raise
            except (RPCError, ValueError):
                # Access may change after dialog enumeration or peer resolution.
                # Do not lose other rows, or the flag we already obtained.
                pass
        found.append(asdict(Broadcast(
            chat_id=entity.id,
            title=_title(entity),
            username=getattr(entity, "username", None),
            live=live,
            rtmp=rtmp,
            scheduled=scheduled,
        )))
    live_first = sorted(found, key=lambda row: (not row["live"], row["title"].lower()))
    return live_first


async def live_broadcasts(client) -> list[dict]:
    """Only the channels broadcasting right now."""
    return [row for row in await discover_broadcasts(client) if row["live"]]


async def pick_live(client, exclude_chat_ids: set[int] | None = None) -> dict | None:
    """The channel to restream: a live feed that is not the relay's own output.

    The relay publishes into one of the channels it can see, so that channel is
    excluded or the relay would try to restream itself. A live channel is
    preferred over a scheduled one, and the restream target itself is never a
    source.
    """
    excluded = exclude_chat_ids or set()
    for row in await discover_broadcasts(client):
        if row["live"] and row["chat_id"] not in excluded:
            return row
    return None
