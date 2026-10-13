"""Deterministic MTProto boundary tests; never contact Telegram or log in."""
from __future__ import annotations

import unittest
from types import SimpleNamespace

from telethon.errors import InviteHashExpiredError
from telethon.tl.functions.channels import GetFullChannelRequest
from telethon.tl.functions.messages import CheckChatInviteRequest
from telethon.tl.types import (
    Channel, ChatAdminRights, ChatInviteAlready, ChatPhotoEmpty, GroupCall, InputGroupCall,
)

from relay_engine.telegram import (
    TelegramAccessError, TelegramPublisher, require_manage_call, resolve_channel,
)
from telegram_login import _channel_report


INVITE = "https://t.me/+-UyRaC_GVSw3NTU1"


def channel(*, creator=False, manage_call=False):
    return Channel(
        id=42, title="Private destination", photo=ChatPhotoEmpty(), date=None,
        access_hash=123, broadcast=True, creator=creator,
        admin_rights=ChatAdminRights(manage_call=manage_call),
    )


class InviteClient:
    def __init__(self, entity, *, joined=True, expired=False):
        self.entity = entity
        self.joined = joined
        self.expired = expired
        self.full = SimpleNamespace(
            full_chat=SimpleNamespace(
                call=InputGroupCall(7, 8),
                exported_invite=SimpleNamespace(link=INVITE),
            ),
            chats=[entity], users=[],
        )

    async def __call__(self, request):
        if isinstance(request, CheckChatInviteRequest):
            if request.hash != "-UyRaC_GVSw3NTU1":
                raise AssertionError("Invite hash must remain an opaque string")
            if self.expired:
                raise InviteHashExpiredError(request)
            if self.joined:
                return ChatInviteAlready(self.entity)
            return SimpleNamespace(title="Private destination")
        if isinstance(request, GetFullChannelRequest):
            return self.full
        raise AssertionError(f"Unexpected Telegram request: {type(request).__name__}")

    async def get_entity(self, value):
        raise AssertionError("Private invite must not be resolved as a channel id")

    async def iter_dialogs(self):
        yield SimpleNamespace(entity=self.entity)


class PrivateInviteTests(unittest.IsolatedAsyncioTestCase):
    async def test_opaque_invite_resolves_already_joined_channel(self):
        entity, full = await resolve_channel(InviteClient(channel(manage_call=True)), INVITE)
        self.assertEqual(entity.id, 42)
        self.assertEqual(full.full_chat.call.id, 7)
        require_manage_call(entity)

    async def test_report_reads_entity_rights_and_nested_call(self):
        report = await _channel_report(InviteClient(channel(manage_call=True)), INVITE)
        self.assertTrue(report["manage_call"])
        self.assertTrue(report["active_call"])
        self.assertFalse(report["creator"])

    async def test_creator_can_manage_without_admin_rights(self):
        entity, _ = await resolve_channel(InviteClient(channel(creator=True)), INVITE)
        require_manage_call(entity)

    async def test_read_only_member_cannot_publish(self):
        entity, _ = await resolve_channel(InviteClient(channel()), INVITE)
        with self.assertRaises(TelegramAccessError):
            require_manage_call(entity)

    async def test_unjoined_invite_is_rejected_without_joining(self):
        with self.assertRaises(TelegramAccessError):
            await resolve_channel(InviteClient(channel(), joined=False), INVITE)

    async def test_expired_invite_matches_exact_exported_dialogue_invite(self):
        entity, _ = await resolve_channel(InviteClient(channel(creator=True), expired=True), INVITE)
        self.assertEqual(entity.id, 42)

    async def test_expired_invite_does_not_guess_by_title(self):
        client = InviteClient(channel(creator=True), expired=True)
        client.full.full_chat.exported_invite.link = "https://t.me/+DifferentOpaqueHash"
        with self.assertRaises(TelegramAccessError):
            await resolve_channel(client, INVITE)


class ExistingCallTests(unittest.IsolatedAsyncioTestCase):
    """An incompatible output call must be described, never silently replaced."""

    def publisher(self, current):
        entity = channel(manage_call=True)
        publisher = TelegramPublisher(api_id=1, api_hash="hash", session="s", channel=INVITE)
        publisher._entity = entity

        class Client:
            def is_connected(self):
                return True

            async def __call__(self, request):
                if isinstance(request, GetFullChannelRequest):
                    return SimpleNamespace(
                        full_chat=SimpleNamespace(call=InputGroupCall(7, 8)),
                        chats=[entity], users=[],
                    )
                return SimpleNamespace(call=current)

        publisher.client = Client()
        return publisher

    async def test_non_rtmp_call_is_reported_with_its_facts(self):
        call = GroupCall(
            id=7, access_hash=8, participants_count=0, unmuted_video_limit=0,
            version=1, join_muted=False, can_change_join_muted=False,
            join_date_asc=False, rtmp_stream=False,
        )
        with self.assertRaises(TelegramAccessError) as raised:
            await self.publisher(call).destination()
        message = str(raised.exception)
        self.assertIn("rtmp=False", message)
        self.assertIn("participants=0", message)

    async def test_non_group_call_is_reported_as_such(self):
        with self.assertRaises(TelegramAccessError) as raised:
            await self.publisher(SimpleNamespace(id=7)).destination()
        self.assertIn("not a Telegram group call", str(raised.exception))


if __name__ == "__main__":
    unittest.main()
