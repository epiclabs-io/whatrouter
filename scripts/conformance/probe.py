"""WhatRouter conformance probe.

Drives the REAL Hermes gateway relay client
(``gateway.relay.ws_transport.WebSocketRelayTransport``) against a running
WhatRouter with ``WHATROUTER_FAKE_WHATSAPP=1``: handshake and descriptor,
per-profile routing and isolation, the relevance gate, every outbound op's
result shape, media re-hosting through ``gateway.relay.media.RelayMediaClient``,
and the going_idle / buffered-replay / reconnect state machine.

Run it through ``scripts/conformance/run.sh`` (which starts the server and
supplies the environment). Exits 1 if any check fails.
"""

from __future__ import annotations

import asyncio
import base64
import json
import os
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any, Optional

BASE = os.environ.get("WHATROUTER_URL", "http://127.0.0.1:8467")
GW_A = os.environ.get("WR_GATEWAY_A", "gw-a")
GW_B = os.environ.get("WR_GATEWAY_B", "gw-b")
SECRET_A = os.environ.get("WR_SECRET_A", "")
SECRET_B = os.environ.get("WR_SECRET_B", "")

ALICE = "+34600000001"
ALICE_JID = "34600000001@s.whatsapp.net"
BOB = "+34600000002"
BOB_JID = "34600000002@s.whatsapp.net"
STRANGER = "+34600000009"
GROUP = "120363000000000001@g.us"

# A tiny but real JPEG header; the bytes only have to survive the round trip.
JPEG = bytes([0xFF, 0xD8, 0xFF, 0xDB, 0x00, 0x43, 0x00, 0x08, 0xFF, 0xD9])

RESULTS: list[tuple[bool, str]] = []


def check(name: str, ok: Any, detail: str = "") -> bool:
    ok = bool(ok)
    RESULTS.append((ok, name))
    line = f"[{'PASS' if ok else 'FAIL'}] {name}"
    if not ok and detail:
        line += f" -- {detail}"
    print(line, flush=True)
    return ok


def post_inbound(body: dict[str, Any]) -> None:
    """Inject a WhatsApp message (only enabled with WHATROUTER_FAKE_WHATSAPP=1)."""
    req = urllib.request.Request(
        f"{BASE}/debug/inbound",
        method="POST",
        data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=10) as resp:
        resp.read()


def get_json(path: str) -> dict[str, Any]:
    with urllib.request.urlopen(f"{BASE}{path}", timeout=10) as resp:
        return json.loads(resp.read().decode())


def wait_healthy(timeout_s: float = 20.0) -> None:
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        try:
            get_json("/healthz")
            return
        except Exception:  # noqa: BLE001 - the server may still be booting
            time.sleep(0.2)
    raise SystemExit("whatrouter never answered /healthz")


async def drain(inbox: "asyncio.Queue[Any]", timeout: float = 5.0) -> Optional[Any]:
    """The next event, or None if it never came (a failed check, not a crash)."""
    try:
        return await asyncio.wait_for(inbox.get(), timeout)
    except asyncio.TimeoutError:
        return None


async def main() -> int:  # noqa: PLR0915 - a linear probe reads better than helpers
    wait_healthy()

    from gateway.platforms.event import MessageType
    from gateway.relay.media import RelayMediaClient
    from gateway.relay.ws_transport import WebSocketRelayTransport

    def transport(gateway_id: str, secret: str) -> WebSocketRelayTransport:
        return WebSocketRelayTransport(
            BASE, "whatsapp", "", gateway_id=gateway_id, upgrade_secret=secret
        )

    async def connect(gateway_id: str, secret: str) -> tuple[Any, "asyncio.Queue[Any]"]:
        inbox: asyncio.Queue[Any] = asyncio.Queue()
        t = transport(gateway_id, secret)
        t.set_inbound_handler(lambda e: inbox.put(e))
        await t.connect()
        await t.handshake()
        return t, inbox

    # ── handshake ────────────────────────────────────────────────────────
    ta, a_inbox = await connect(GW_A, SECRET_A)
    tb, b_inbox = await connect(GW_B, SECRET_B)
    d = await ta.handshake()

    check("descriptor: contract_version 1, platform whatsapp",
          d.contract_version == 1 and d.platform == "whatsapp")
    check("descriptor: max_message_length 4096, len_unit chars",
          d.max_message_length == 4096 and d.len_unit == "chars")
    check("descriptor: supports_edit False by default", d.supports_edit is False)
    check(
        "descriptor: advertises send/edit/delete/typing/react/send_media/get_chat_info",
        all(d.supports_op(op) for op in
            ("send", "edit", "delete", "typing", "react", "send_media", "get_chat_info")),
    )
    check("descriptor: does not advertise follow_up / thread_create",
          not d.supports_op("follow_up") and not d.supports_op("thread_create"))
    check("descriptor: code blocks are safe (markdown_dialect not plain)",
          d.markdown_dialect not in ("", "plain"))
    check("descriptor: both profiles handshook independently",
          (await tb.handshake()).platform == "whatsapp")

    # ── inbound routing ──────────────────────────────────────────────────
    post_inbound({"chatId": ALICE, "text": "hola", "senderName": "Alice", "messageId": "m1"})
    e = await drain(a_inbox)
    check("routed DM reaches its profile (real _event_from_wire)", e is not None and e.text == "hola",
          f"got {e!r}")
    if e is not None:
        check("event.source: canonical chat_id / user_id / chat_type",
              e.source.chat_id == ALICE_JID and e.source.user_id == ALICE_JID
              and e.source.chat_type == "dm",
              f"{e.source.chat_id} {e.source.user_id} {e.source.chat_type}")
        check("event.source.platform is whatsapp, stamped as relay-delivered",
              e.source.platform.value == "whatsapp" and e.source.delivered_via_upstream_relay)
        check("event: message_type text, message_id and chat_name carried",
              e.message_type == MessageType.TEXT and e.message_id == "m1"
              and e.source.chat_name == "Alice",
              f"{e.message_type} {e.message_id} {e.source.chat_name}")

    await asyncio.sleep(0.3)
    check("the other profile sees nothing of it", b_inbox.empty())

    post_inbound({"chatId": ALICE, "text": "/help", "messageId": "m2"})
    e = await drain(a_inbox)
    check("a slash command arrives as MessageType.COMMAND",
          e is not None and e.message_type == MessageType.COMMAND, f"got {e!r}")

    post_inbound({"chatId": BOB, "text": "hey", "messageId": "m3"})
    e = await drain(b_inbox)
    check("the second profile receives its own DM", e is not None and e.text == "hey")
    await asyncio.sleep(0.3)
    check("...and it never reaches the first profile", a_inbox.empty())

    post_inbound({"chatId": STRANGER, "text": "who are you", "messageId": "m4"})
    await asyncio.sleep(0.4)
    check("an unrouted DM reaches nobody (fail-closed)",
          a_inbox.empty() and b_inbox.empty())

    post_inbound({"chatId": GROUP, "chatType": "group", "senderId": ALICE,
                  "text": "just chatter", "messageId": "g1"})
    await asyncio.sleep(0.4)
    check("an unaddressed group message reaches nobody",
          a_inbox.empty() and b_inbox.empty())

    post_inbound({"chatId": GROUP, "chatType": "group", "senderId": ALICE,
                  "text": "@bot are you there", "mentionsBot": True, "messageId": "g2"})
    e = await drain(a_inbox)
    check("a group message that mentions the bot is delivered",
          e is not None and e.source.chat_id == GROUP and e.source.chat_type == "group",
          f"got {e!r}")

    post_inbound({"chatId": GROUP, "chatType": "group", "senderId": ALICE,
                  "text": "/status", "messageId": "g3"})
    e = await drain(a_inbox)
    check("a slash command in a group bypasses the mention gate",
          e is not None and e.message_type == MessageType.COMMAND, f"got {e!r}")

    # ── outbound ops ─────────────────────────────────────────────────────
    r = await ta.send_outbound({"op": "send", "chat_id": ALICE_JID, "content": "reply"})
    check("send -> success + message_id", r.get("success") is True and bool(r.get("message_id")), str(r))

    r = await ta.send_outbound({"op": "send", "chat_id": BOB_JID, "content": "not mine"})
    check("A cannot send to B's chat", r.get("success") is False
          and "not routed" in r.get("error", ""), str(r))

    r = await tb.send_outbound({"op": "send", "chat_id": ALICE_JID, "content": "not mine"})
    check("B cannot send to A's chat", r.get("success") is False
          and "not routed" in r.get("error", ""), str(r))

    r = await ta.send_outbound({"op": "typing", "chat_id": ALICE_JID, "content": ""})
    check("typing -> success", r.get("success") is True, str(r))

    r = await ta.send_outbound({"op": "react", "chat_id": ALICE_JID,
                                "message_id": "m1", "emoji": "👍"})
    check("react -> success", r.get("success") is True, str(r))

    r = await ta.send_outbound({"op": "edit", "chat_id": ALICE_JID,
                                "message_id": "m1", "content": "edited"})
    check("edit -> success", r.get("success") is True, str(r))

    r = await ta.send_outbound({"op": "delete", "chat_id": ALICE_JID, "message_id": "m1"})
    check("delete -> success", r.get("success") is True, str(r))

    info = await ta.get_chat_info(ALICE_JID)
    check("get_chat_info -> name/type", info.get("type") == "dm" and bool(info.get("name")), str(info))

    r = await ta.send_outbound({"op": "thread_create", "chat_id": ALICE_JID, "thread_name": "n"})
    check("an unadvertised op fails structurally",
          r.get("success") is False and "unsupported op" in r.get("error", ""), str(r))

    r = await ta.send_outbound({"op": "send", "chat_id": ALICE_JID, "content": "x"},
                               platform="discord")
    check("a frame tagged with another platform is refused",
          r.get("success") is False and "not fronted" in r.get("error", ""), str(r))

    r = await ta.send_outbound({"op": "send", "chat_id": ALICE_JID, "content": ""})
    check("an empty send is refused", r.get("success") is False, str(r))

    # ── media ────────────────────────────────────────────────────────────
    post_inbound({
        "chatId": ALICE, "text": "a photo", "kind": "image",
        "mediaBase64": base64.b64encode(JPEG).decode(),
        "mediaMime": "image/jpeg", "mediaFilename": "cat.jpg", "messageId": "m5",
    })
    e = await drain(a_inbox)
    media_url = ""
    if check("inbound media is delivered as a photo",
             e is not None and e.message_type == MessageType.PHOTO, f"got {e!r}") and e is not None:
        media_url = e.media_urls[0] if e.media_urls else ""
        check("media_urls[0] is a connector re-host url",
              "/relay/media/" in media_url and len(media_url.rsplit("/", 1)[-1]) == 32, media_url)
        check("media_types resolves by url lookup into media[]",
              e.media_types == ["image/jpeg"], str(e.media_types))

    media_a = RelayMediaClient(BASE, GW_A, SECRET_A)
    media_b = RelayMediaClient(BASE, GW_B, SECRET_B)
    path = await media_a.download(media_url) if media_url else None
    check("the owning profile downloads the exact bytes",
          path is not None and Path(path).read_bytes() == JPEG, str(path))
    if path is not None:
        Path(path).unlink(missing_ok=True)

    foreign = await media_b.download(media_url) if media_url else None
    check("another profile cannot download it", foreign is None, str(foreign))

    r = await ta.send_outbound({"op": "send_media", "chat_id": ALICE_JID, "media_kind": "image",
                                "source_url": media_url, "content": "here it is"})
    check("send_media resolves our own re-host url",
          r.get("success") is True and bool(r.get("message_id")), str(r))

    r = await tb.send_outbound({"op": "send_media", "chat_id": BOB_JID, "media_kind": "image",
                                "source_url": media_url, "content": "stolen"})
    check("send_media of another profile's media is refused",
          r.get("success") is False and "not found" in r.get("error", ""), str(r))

    # ── going idle, buffering, replay ────────────────────────────────────
    check("going_idle is acked", await ta.go_idle(timeout_s=5))

    post_inbound({"chatId": ALICE, "text": "buffered-1", "messageId": "b1"})
    post_inbound({"chatId": ALICE, "text": "buffered-2", "messageId": "b2"})
    await asyncio.sleep(0.5)
    check("nothing is delivered live after the flip", a_inbox.empty())
    health = get_json("/healthz")
    check("healthz shows the buffered depth",
          health.get("profiles", {}).get("a", {}).get("buffered") == 2, json.dumps(health))

    await ta.disconnect()
    ta2, a2_inbox = await connect(GW_A, SECRET_A)
    first = await drain(a2_inbox)
    second = await drain(a2_inbox)
    check("the backlog replays in order after re-handshake",
          first is not None and second is not None
          and (first.text, second.text) == ("buffered-1", "buffered-2"),
          f"{first!r} {second!r}")

    await asyncio.sleep(0.4)
    post_inbound({"chatId": ALICE, "text": "live-again", "messageId": "b3"})
    third = await drain(a2_inbox)
    check("live delivery resumes once the buffer drains",
          third is not None and third.text == "live-again", f"got {third!r}")

    await ta2.disconnect()
    ta3, a3_inbox = await connect(GW_A, SECRET_A)
    await asyncio.sleep(0.8)
    check("an acked backlog is never redelivered", a3_inbox.empty())

    # ── auth edge cases ──────────────────────────────────────────────────
    t_dup = transport(GW_A, SECRET_A)
    dup_rejected = False
    try:
        await t_dup.connect()
        await asyncio.wait_for(t_dup.handshake(), 2)
    except Exception:  # noqa: BLE001 - the point is that it does not complete
        dup_rejected = True
    check("a duplicate session is rejected without latching auth_revoked",
          dup_rejected and not t_dup.auth_revoked)
    await t_dup.disconnect()

    t_bad = transport(GW_A, "wrong-secret-wrong-secret-wrong-secret")
    bad_rejected = False
    try:
        await t_bad.connect()
        await asyncio.wait_for(t_bad.handshake(), 2)
    except Exception:  # noqa: BLE001
        bad_rejected = True
    check("a bad secret gets no descriptor and does not latch a revocation",
          bad_rejected and not t_bad.auth_revoked)
    await t_bad.disconnect()

    # ── final state ──────────────────────────────────────────────────────
    check("the second profile never saw any of it", b_inbox.empty())
    health = get_json("/healthz")
    check("healthz: status ok, whatsapp connected, both profiles listed",
          health.get("status") == "ok" and health.get("whatsapp") == "connected"
          and set(health.get("profiles", {})) == {"a", "b"},
          json.dumps(health))

    await ta3.disconnect()
    await tb.disconnect()

    passed = sum(1 for ok, _ in RESULTS if ok)
    print(f"\n{passed}/{len(RESULTS)} checks passed", flush=True)
    if passed != len(RESULTS):
        for ok, name in RESULTS:
            if not ok:
                print(f"  failed: {name}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
