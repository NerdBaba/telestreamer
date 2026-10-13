"""Discover every live broadcast the authorized session can see.

The relay used to pin one channel, which meant a new racing feed required a
redeploy. The session is already a member of several racing channels, so it can
enumerate all of them and report which are broadcasting right now.

Only the public Telethon surface is used: dialogs, entities, and the call
attached to a channel. Nothing is joined, no message is posted, and no identity
is exposed to the channels being inspected.
"""

from __future__ import annotations

from dataclasses import dataclass, asdict


@dataclass(frozen=True)
class Broadcast:
    """One channel that is either broadcasting or could broadcast later."""
    chat_id: int
    title: str
    username: str | None
    live: bool = False
    rtmp: bool = False
    scheduled: bool = False


def _title(entity) -> str:
    return (getattr(entity, "title", None) or "").strip() or str(getattr(entity, "id", ""))


async def discover_broadcasts(client) -> list[dict]:
    """Every channel the session can see, with its current broadcast state.

    A channel is listed even when idle so the caller can distinguish "no feed"
    from "not a channel at all". Live state comes from the group call attached
    to the channel, which is the same signal the publisher uses.
    """
    found: list[dict] = []
    async for dialog in client.iter_dialogs():
        entity = dialog.entity
        if not getattr(entity, "broadcast", False):
            continue
        call = getattr(entity, "call", None)
        live = call is not None and not bool(getattr(call, "schedule_date", None))
        found.append(asdict(Broadcast(
            chat_id=entity.id,
            title=_title(entity),
            username=getattr(entity, "username", None),
            live=live,
            rtmp=bool(getattr(call, "rtmp_stream", False)) if call else False,
            scheduled=bool(getattr(call, "schedule_date", None)),
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
