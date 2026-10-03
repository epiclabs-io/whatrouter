import { describe, expect, it } from "vitest";
import {
  buildRouteTable,
  canonicalChatId,
  DELIVERED_MEMORY_MAX,
  isRoutedTo,
  resolveProfile,
} from "../../src/router/routes.js";
import { testConfig } from "../helpers/relay.js";
import {
  ALICE,
  BOB,
  CAROL,
  GROUP,
  ROGUE,
  dmRoute,
  groupRoute,
  inbound,
  profileWith,
  routerConfig,
} from "../helpers/router.js";

describe("canonicalChatId", () => {
  it("accepts every way an operator or the gateway writes a chat id", () => {
    expect(canonicalChatId("+34 600 000 001")).toBe(ALICE);
    expect(canonicalChatId("34600000001")).toBe(ALICE);
    expect(canonicalChatId("34600000001@c.us")).toBe(ALICE);
    expect(canonicalChatId("34600000001:12@s.whatsapp.net")).toBe(ALICE);
    expect(canonicalChatId(GROUP)).toBe(GROUP);
    expect(canonicalChatId("")).toBe("");
    expect(canonicalChatId(null)).toBe("");
  });
});

describe("buildRouteTable", () => {
  it("keys DM routes by canonical user jid and groups by their jid", () => {
    const config = routerConfig();
    const table = buildRouteTable(config);
    expect([...table.keys()].sort()).toEqual([ALICE, BOB, GROUP].sort());
    expect(table.get(ALICE)?.profile.name).toBe("a");
    expect(table.get(GROUP)?.profile.name).toBe("a");
    expect(table.get(BOB)?.profile.name).toBe("b");
    expect(table.get(GROUP)?.route.kind).toBe("group");
  });
});

describe("resolveProfile", () => {
  it("matches the chat id exactly", () => {
    const config = routerConfig();
    const table = buildRouteTable(config);
    const match = resolveProfile(table, config, inbound());
    expect(match?.profile.name).toBe("a");
    expect(match?.route).toEqual(dmRoute(ALICE));
  });

  it("matches a DM through the other form of the sender id (lid route, phone message)", () => {
    const config = testConfig({ profiles: [profileWith("a", [dmRoute("777888999@lid")])] });
    const table = buildRouteTable(config);
    const m = inbound({ chatId: ALICE, senderId: ALICE, senderIdAlt: "777888999@lid" });
    expect(resolveProfile(table, config, m)?.profile.name).toBe("a");
  });

  it("matches a DM that arrived as a lid against a phone route", () => {
    const config = routerConfig();
    const table = buildRouteTable(config);
    const m = inbound({
      chatId: "777888999@lid",
      chatIdRaw: "777888999@lid",
      senderId: "777888999@lid",
      senderIdAlt: ALICE,
    });
    expect(resolveProfile(table, config, m)?.profile.name).toBe("a");
  });

  it("does not use the alt id for group chats", () => {
    const config = testConfig({ profiles: [profileWith("a", [dmRoute(ALICE)])] });
    const table = buildRouteTable(config);
    const m = inbound({
      chatId: GROUP,
      chatType: "group",
      senderId: "777888999@lid",
      senderIdAlt: ALICE,
    });
    expect(resolveProfile(table, config, m)).toBeNull();
  });

  it("falls back to default_profile with a null route", () => {
    const config = routerConfig({ defaultProfile: "b" });
    const table = buildRouteTable(config);
    const match = resolveProfile(table, config, inbound({ chatId: CAROL, senderId: CAROL }));
    expect(match?.profile.name).toBe("b");
    expect(match?.route).toBeNull();
  });

  it("does not extend default_profile to an unrouted group", () => {
    const config = routerConfig({ defaultProfile: "b" });
    const table = buildRouteTable(config);
    // A group no profile claims: it belongs to everyone, so handing it to the
    // default profile would answer people nobody routed here.
    const m = inbound({ chatId: ROGUE, chatType: "group", senderId: CAROL });
    expect(resolveProfile(table, config, m)).toBeNull();
  });

  it("still routes a group that a profile claims, with default_profile set", () => {
    const config = routerConfig({ defaultProfile: "b" });
    const table = buildRouteTable(config);
    const m = inbound({ chatId: GROUP, chatType: "group", senderId: ALICE });
    expect(resolveProfile(table, config, m)?.profile.name).toBe("a");
  });

  it("returns null for an unrouted chat when there is no default profile", () => {
    const config = routerConfig();
    const table = buildRouteTable(config);
    expect(resolveProfile(table, config, inbound({ chatId: CAROL, senderId: CAROL }))).toBeNull();
  });
});

describe("isRoutedTo", () => {
  it("allows the owning profile and refuses every other one", () => {
    const config = routerConfig();
    const table = buildRouteTable(config);
    expect(isRoutedTo(table, config, "a", ALICE)).toBe(true);
    expect(isRoutedTo(table, config, "b", ALICE)).toBe(false);
    expect(isRoutedTo(table, config, "a", GROUP)).toBe(true);
    expect(isRoutedTo(table, config, "b", GROUP)).toBe(false);
    expect(isRoutedTo(table, config, "a", BOB)).toBe(false);
  });

  it("accepts the same chat written in other forms", () => {
    const config = routerConfig();
    const table = buildRouteTable(config);
    expect(isRoutedTo(table, config, "a", "+34600000001")).toBe(true);
    expect(isRoutedTo(table, config, "a", "34600000001@c.us")).toBe(true);
  });

  it("refuses an unrouted chat, and an empty chat id", () => {
    const config = routerConfig();
    const table = buildRouteTable(config);
    expect(isRoutedTo(table, config, "a", CAROL)).toBe(false);
    expect(isRoutedTo(table, config, "a", "")).toBe(false);
  });

  it("lets a profile reply to a chat it actually received (default_profile case)", () => {
    const config = routerConfig({ defaultProfile: "b" });
    const table = buildRouteTable(config);
    expect(isRoutedTo(table, config, "b", CAROL)).toBe(false);
    table.remember(CAROL, "b");
    expect(isRoutedTo(table, config, "b", CAROL)).toBe(true);
    expect(isRoutedTo(table, config, "a", CAROL)).toBe(false);
  });

  it("never lets the memory override an explicit route", () => {
    const config = routerConfig();
    const table = buildRouteTable(config);
    table.remember(ALICE, "b");
    expect(isRoutedTo(table, config, "b", ALICE)).toBe(false);
    expect(isRoutedTo(table, config, "a", ALICE)).toBe(true);
  });

  it("allow_unrouted_outbound turns the tenant check off", () => {
    const config = routerConfig({ allowUnroutedOutbound: true });
    const table = buildRouteTable(config);
    expect(isRoutedTo(table, config, "b", ALICE)).toBe(true);
    expect(isRoutedTo(table, config, "b", CAROL)).toBe(true);
  });

  it("bounds the delivered-chat memory", () => {
    const config = routerConfig();
    const table = buildRouteTable(config);
    for (let i = 0; i < DELIVERED_MEMORY_MAX + 50; i++) {
      table.remember(`3460000${String(i).padStart(4, "0")}@s.whatsapp.net`, "a");
    }
    expect(table.rememberedSize).toBe(DELIVERED_MEMORY_MAX);
    // The newest entries survive, the oldest are evicted.
    expect(table.rememberedProfile("34600001049@s.whatsapp.net")).toBe("a");
    expect(table.rememberedProfile("34600000000@s.whatsapp.net")).toBeUndefined();
  });
});

describe("group routes", () => {
  it("keeps require_mention and allowed_senders on the route", () => {
    const config = testConfig({
      profiles: [
        profileWith("a", [groupRoute(GROUP, { requireMention: false, allowedSenders: [ALICE] })]),
      ],
    });
    const table = buildRouteTable(config);
    const route = table.get(GROUP)?.route;
    expect(route?.kind).toBe("group");
    expect(route).toMatchObject({ requireMention: false, allowedSenders: [ALICE] });
  });
});
