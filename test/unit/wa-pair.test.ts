import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { Boom } from "@hapi/boom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runPair } from "../../src/whatsapp/pair.js";
import {
  captureIo,
  createFakeSocket,
  makeEmptyAuthDir,
  silentLog,
  testConfig,
  type FakeSocket,
} from "../helpers/wa.js";

const dirs: string[] = [];

afterEach(async () => {
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir !== undefined) {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

async function startPair(options: { code?: string; timeoutMs?: number } = {}): Promise<{
  exit: Promise<number>;
  sockets: FakeSocket[];
  io: ReturnType<typeof captureIo>;
  dir: string;
  waitForSocket: (n: number) => Promise<FakeSocket>;
}> {
  const dir = await makeEmptyAuthDir();
  dirs.push(dir);
  const sockets: FakeSocket[] = [];
  const io = captureIo();

  const exit = runPair({
    config: testConfig(),
    log: silentLog(),
    io: io.io,
    authDir: dir,
    settleMs: 0,
    timeoutMs: options.timeoutMs ?? 5_000,
    ...(options.code === undefined ? {} : { code: options.code }),
    makeSocket: () => {
      const fake = createFakeSocket();
      fake.setUser({ id: "34600000099:12@s.whatsapp.net" });
      sockets.push(fake);
      return fake.socket;
    },
  });

  const waitForSocket = async (n: number): Promise<FakeSocket> => {
    await vi.waitFor(() => expect(sockets.length).toBeGreaterThanOrEqual(n));
    return sockets[n - 1] as FakeSocket;
  };

  return { exit, sockets, io, dir, waitForSocket };
}

describe("runPair: QR flow", () => {
  it("prints the QR code and exits 0 once the socket opens", async () => {
    const p = await startPair();
    const sock = await p.waitForSocket(1);

    sock.ev.emit("connection.update", { qr: "QR-PAYLOAD-1" });
    sock.ev.emit("connection.update", { connection: "open" });

    expect(await p.exit).toBe(0);
    const creds = JSON.parse(await readFile(join(p.dir, "creds.json"), "utf8")) as {
      registered: boolean;
    };
    expect(creds.registered).toBe(true);
    expect(p.io.out[0]).toBe(
      "Scan this QR with WhatsApp → Settings → Linked devices → Link a device:"
    );
    // qrcode-terminal renders block characters, not the payload itself.
    expect(p.io.out[1]).toMatch(/[▀-▟]/);
    expect(p.io.out.at(-1)).toBe(`Paired as 34600000099. Credentials saved to ${p.dir}.`);
    expect(sock.pairingRequests).toEqual([]);
    expect(sock.ended).toBe(1);
  });

  it("prints the QR only once", async () => {
    const p = await startPair();
    const sock = await p.waitForSocket(1);

    sock.ev.emit("connection.update", { qr: "QR-PAYLOAD-1" });
    sock.ev.emit("connection.update", { qr: "QR-PAYLOAD-2" });
    sock.ev.emit("connection.update", { connection: "open" });

    await p.exit;
    expect(p.io.out.filter((line) => line.startsWith("Scan this QR"))).toHaveLength(1);
  });
});

describe("runPair: pairing code flow", () => {
  it("requests one code, prints it grouped, and never prints a QR", async () => {
    const p = await startPair({ code: "+34 600 000 099" });
    const sock = await p.waitForSocket(1);

    sock.ev.emit("connection.update", { connection: "connecting" });
    sock.ev.emit("connection.update", { qr: "QR-PAYLOAD-1" });
    await vi.waitFor(() => expect(p.io.out.some((l) => l.startsWith("Pairing code:"))).toBe(true));
    sock.ev.emit("connection.update", { connection: "open" });

    expect(await p.exit).toBe(0);
    expect(sock.pairingRequests).toEqual(["34600000099"]);
    expect(p.io.out).toContain("Pairing code: ABCD-1234");
    expect(p.io.out).toContain(
      "Enter it in WhatsApp → Settings → Linked devices → Link with phone number instead."
    );
    expect(p.io.out.some((line) => line.startsWith("Scan this QR"))).toBe(false);
  });

  it("rejects a --code value that is not a phone number", async () => {
    const dir = await makeEmptyAuthDir();
    dirs.push(dir);
    const io = captureIo();
    const makeSocket = vi.fn();

    const exit = await runPair({
      config: testConfig(),
      log: silentLog(),
      io: io.io,
      authDir: dir,
      code: "not-a-phone",
      makeSocket: makeSocket as never,
    });

    expect(exit).toBe(1);
    expect(makeSocket).not.toHaveBeenCalled();
    expect(io.err[0]).toMatch(/--code needs a phone number/);
  });
});

describe("runPair: connection outcomes", () => {
  it("reconnects silently after a 515 restart", async () => {
    const p = await startPair();
    const first = await p.waitForSocket(1);

    first.ev.emit("connection.update", {
      connection: "close",
      lastDisconnect: {
        error: new Boom("restart required", { statusCode: 515 }),
        date: new Date(),
      },
    });

    const second = await p.waitForSocket(2);
    second.ev.emit("connection.update", { connection: "open" });

    expect(await p.exit).toBe(0);
    expect(p.io.err).toEqual([]);
  });

  it("explains how to reset after a logout", async () => {
    const p = await startPair();
    const sock = await p.waitForSocket(1);

    sock.ev.emit("connection.update", {
      connection: "close",
      lastDisconnect: { error: new Boom("logged out", { statusCode: 401 }), date: new Date() },
    });

    expect(await p.exit).toBe(1);
    expect(p.io.err).toContain(`Remove the stored credentials and pair again: rm -rf ${p.dir}`);
  });

  it("gives up after the overall timeout", async () => {
    const p = await startPair({ timeoutMs: 20 });
    await p.waitForSocket(1);

    expect(await p.exit).toBe(1);
    expect(p.io.err[0]).toBe("error: pairing timed out after 0s");
  });
});
