/**
 * `fetchPublic` — the check on the address a media fetch may reach.
 *
 * The servers here bind to loopback, so the default classifier would refuse
 * every one of them; the tests that need a body therefore inject an
 * `isBlocked`. The classifier itself is exercised with its real ranges in the
 * first block, and the "refused without asking" cases use the default.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { fetchPublic, isBlockedAddress } from "../../src/util/public-fetch.js";

const OPTS = { maxBytes: 1024, timeoutMs: 5_000 };

/** Lets the loopback servers below be dialled; blocks nothing else on them. */
const allowLoopback = (): boolean => false;

interface TestServer {
  origin: string;
  close(): Promise<void>;
}

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        })
    )
  );
});

/** Binds to 127.0.0.1 on an ephemeral port. */
async function serve(
  handler: (url: URL) => {
    status?: number;
    headers?: Record<string, string>;
    body?: Buffer | string;
  }
): Promise<TestServer> {
  const server = createServer((req, res) => {
    const spec = handler(new URL(req.url ?? "/", "http://127.0.0.1"));
    res.writeHead(spec.status ?? 200, spec.headers ?? {});
    res.end(spec.body ?? "");
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { origin: `http://127.0.0.1:${port}`, close: async () => undefined };
}

describe("isBlockedAddress", () => {
  it.each([
    ["0.0.0.0/8", "0.1.2.3"],
    ["10.0.0.0/8", "10.255.255.254"],
    ["100.64.0.0/10", "100.127.255.255"],
    ["127.0.0.0/8", "127.0.0.1"],
    ["169.254.0.0/16", "169.254.169.254"],
    ["172.16.0.0/12", "172.31.255.255"],
    ["192.0.0.0/24", "192.0.0.8"],
    ["192.168.0.0/16", "192.168.1.1"],
    ["198.18.0.0/15", "198.19.255.255"],
    ["224.0.0.0/4", "239.255.255.255"],
    ["240.0.0.0/4", "255.255.255.255"],
    ["::/128", "::"],
    ["::1/128", "::1"],
    ["64:ff9b::/96", "64:ff9b::7f00:1"],
    ["fc00::/7", "fdff::1"],
    ["fe80::/10", "fe80::1"],
    ["ff00::/8", "ff02::1"],
  ])("blocks %s (%s)", (_range, ip) => {
    expect(isBlockedAddress(ip)).toBe(true);
  });

  it.each([
    ["1.1.1.1"],
    ["8.8.8.8"],
    ["9.9.9.9"],
    ["172.15.255.255"],
    ["172.32.0.1"],
    ["100.63.255.255"],
    ["100.128.0.1"],
    ["192.0.1.1"],
    ["198.20.0.1"],
    ["223.255.255.255"],
    ["2606:4700:4700::1111"],
    ["2a00:1450:4001:80f::200e"],
  ])("allows the public address %s", (ip) => {
    expect(isBlockedAddress(ip)).toBe(false);
  });

  it("treats an IPv4-mapped IPv6 address as its IPv4 address", () => {
    expect(isBlockedAddress("::ffff:127.0.0.1")).toBe(true);
    expect(isBlockedAddress("::FFFF:10.0.0.1")).toBe(true);
    expect(isBlockedAddress("::ffff:169.254.169.254")).toBe(true);
    // The hex spelling of the same address: ::ffff:7f00:1.
    expect(isBlockedAddress("::ffff:7f00:1")).toBe(true);
    expect(isBlockedAddress("::ffff:a00:1")).toBe(true);
    // A mapped public address is still public.
    expect(isBlockedAddress("::ffff:8.8.8.8")).toBe(false);
  });

  it("ignores brackets and zone indexes, and refuses what is not an address", () => {
    expect(isBlockedAddress("[::1]")).toBe(true);
    expect(isBlockedAddress("fe80::1%eth0")).toBe(true);
    expect(isBlockedAddress("2606:4700::1111%eth0")).toBe(false);
    expect(isBlockedAddress("")).toBe(true);
    expect(isBlockedAddress("not-an-ip")).toBe(true);
  });
});

describe("fetchPublic", () => {
  it("refuses a default-blocked loopback address without dialling it", async () => {
    const result = await fetchPublic("http://127.0.0.1:1/latest/meta-data", OPTS);
    expect(result).toEqual({ ok: false, error: "source_url not allowed" });
  });

  it("refuses the cloud metadata address", async () => {
    expect(await fetchPublic("http://169.254.169.254/latest", OPTS)).toEqual({
      ok: false,
      error: "source_url not allowed",
    });
  });

  it("refuses a scheme it will not dial", async () => {
    for (const url of ["file:///etc/passwd", "ftp://example.com/x", "gopher://example.com/x"]) {
      expect(await fetchPublic(url, OPTS)).toEqual({ ok: false, error: "source_url not allowed" });
    }
    expect(await fetchPublic("not a url", OPTS)).toEqual({
      ok: false,
      error: "source_url not allowed",
    });
  });

  it("fetches an allowed address and takes the mime from the response", async () => {
    const body = Buffer.from([1, 2, 3, 4]);
    const server = await serve(() => ({
      headers: { "content-type": "image/png; charset=binary", "content-length": "4" },
      body,
    }));
    const result = await fetchPublic(`${server.origin}/cat.png`, {
      ...OPTS,
      isBlocked: allowLoopback,
    });
    expect(result).toEqual({ ok: true, bytes: new Uint8Array(body), mime: "image/png" });
  });

  it("defaults the mime when the response has no content-type", async () => {
    const server = await serve(() => ({ body: "hi" }));
    const result = await fetchPublic(`${server.origin}/x`, { ...OPTS, isBlocked: allowLoopback });
    expect(result).toMatchObject({ ok: true, mime: "application/octet-stream" });
  });

  it("refuses an address the injected classifier blocks, at the lookup", async () => {
    // A hostname, so the check happens on the resolved address in `lookup`.
    const server = await serve(() => ({ body: "hi" }));
    const result = await fetchPublic(`${server.origin}/x`, {
      ...OPTS,
      isBlocked: () => true,
    });
    expect(result).toEqual({ ok: false, error: "source_url not allowed" });
  });

  it("refuses a redirect into a blocked address", async () => {
    const target = await serve(() => ({ body: "secret" }));
    // Server A lives on 127.0.0.1 and redirects to 127.0.0.2, which the
    // injected classifier blocks even though it is a literal the resolver
    // never sees.
    const blocker = createServer((_req, res) => {
      res.writeHead(302, { location: target.origin.replace("127.0.0.1", "127.0.0.2") });
      res.end();
    });
    servers.push(blocker);
    await new Promise<void>((resolve) => blocker.listen(0, "127.0.0.1", resolve));
    const { port } = blocker.address() as AddressInfo;

    const result = await fetchPublic(`http://127.0.0.1:${port}/hop`, {
      ...OPTS,
      isBlocked: (ip) => ip === "127.0.0.2",
    });
    expect(result).toEqual({ ok: false, error: "source_url not allowed" });
  });

  it("follows up to three redirects, resolving a relative Location", async () => {
    // 301, 302, 307 and 308 in one chain, each Location relative to the current URL.
    const seen: string[] = [];
    const statuses = [301, 302, 307, 308] as const;
    const chain = await serve((url) => {
      seen.push(url.pathname);
      const step = Number(url.pathname.slice(1) || "0");
      if (step >= 3) {
        return { body: "arrived" };
      }
      return { status: statuses[step] ?? 302, headers: { location: `/${step + 1}` } };
    });

    const result = await fetchPublic(`${chain.origin}/0`, { ...OPTS, isBlocked: allowLoopback });
    expect(result).toMatchObject({ ok: true });
    expect(new TextDecoder().decode(result.ok ? result.bytes : new Uint8Array())).toBe("arrived");
    // Three redirects followed, on top of the request that finally returned a body.
    expect(seen).toEqual(["/0", "/1", "/2", "/3"]);
  });

  it("refuses a fourth redirect", async () => {
    const loop = await serve((url) => {
      const step = Number(url.pathname.slice(1) || "0");
      return { status: 302, headers: { location: `/${step + 1}` } };
    });
    expect(await fetchPublic(`${loop.origin}/0`, { ...OPTS, isBlocked: allowLoopback })).toEqual({
      ok: false,
      error: "too many redirects",
    });
  });

  it("refuses a chunked body over the cap", async () => {
    const server = await serve(() => ({ body: Buffer.alloc(64 * 1024, 7) }));
    const result = await fetchPublic(`${server.origin}/big`, {
      maxBytes: 1024,
      timeoutMs: 5_000,
      isBlocked: allowLoopback,
    });
    expect(result).toEqual({ ok: false, error: "media is larger than 1024 bytes" });
  });

  it("refuses a body that declares itself over the cap", async () => {
    const server = await serve(() => ({
      headers: { "content-length": "999999" },
      body: "small",
    }));
    const result = await fetchPublic(`${server.origin}/big`, {
      maxBytes: 1024,
      timeoutMs: 5_000,
      isBlocked: allowLoopback,
    });
    expect(result).toEqual({ ok: false, error: "media is larger than 1024 bytes" });
  });

  it("reports a non-2xx status and a dead host as fetch failures", async () => {
    const server = await serve(() => ({ status: 404, body: "nope" }));
    expect(
      await fetchPublic(`${server.origin}/missing`, { ...OPTS, isBlocked: allowLoopback })
    ).toEqual({ ok: false, error: "could not fetch media: HTTP 404" });

    const dead = await fetchPublic("http://127.0.0.1:1/x", {
      ...OPTS,
      isBlocked: allowLoopback,
    });
    expect(dead.ok).toBe(false);
    expect(dead.ok === false && dead.error.startsWith("could not fetch media: ")).toBe(true);
  });

  it("times out rather than hanging", async () => {
    const server = createServer(() => {
      // Never answer.
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    const result = await fetchPublic(`http://127.0.0.1:${port}/hang`, {
      maxBytes: 1024,
      timeoutMs: 150,
      isBlocked: allowLoopback,
    });
    expect(result).toEqual({ ok: false, error: "could not fetch media: timed out after 150 ms" });
  });
});
