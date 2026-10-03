/**
 * Fetching a remote media file, without the network the fetch may not reach.
 *
 * An agent asks WhatRouter to send an image from a URL, and WhatRouter fetches
 * it on the agent's behalf. That makes the router a request proxy: without a
 * check on the resolved address, a compromised or merely curious agent could
 * point `source_url` at the router's own network — a cloud metadata service, a
 * database on the LAN, the router's own admin port.
 *
 * So the address actually dialled is checked, not the hostname: we resolve DNS
 * ourselves and refuse if *any* returned address is non-public, which leaves no
 * rebinding window between the check and the connection. Only `http:` and
 * `https:` are dialled. Redirects are followed by hand, a few at a time, and
 * every hop is checked the same way.
 *
 * There is deliberately no allowlist for LAN hosts (D1): a non-public address is
 * refused, full stop.
 */
import { lookup as dnsLookup } from "node:dns";
import http from "node:http";
import https from "node:https";
import { BlockList, isIP } from "node:net";
import type { LookupAddress, LookupOptions } from "node:dns";

/** Refused for a non-public address or a scheme we will not dial. */
const NOT_ALLOWED = "source_url not allowed";

/** Marks the error raised inside `lookup`, so the caller can report it verbatim. */
const BLOCKED_CODE = "ERR_NON_PUBLIC_ADDRESS";

const DEFAULT_MIME = "application/octet-stream";
const MAX_REDIRECTS = 3;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/**
 * Every address that is not routable on the public internet. Built once: the
 * list is a constant, and rebuilding it per lookup would be pure overhead on a
 * path an agent can drive in a loop.
 */
const NON_PUBLIC = ((): BlockList => {
  const list = new BlockList();
  const ranges: ReadonlyArray<readonly [string, number, "ipv4" | "ipv6"]> = [
    ["0.0.0.0", 8, "ipv4"],
    ["10.0.0.0", 8, "ipv4"],
    ["100.64.0.0", 10, "ipv4"],
    ["127.0.0.0", 8, "ipv4"],
    ["169.254.0.0", 16, "ipv4"],
    ["172.16.0.0", 12, "ipv4"],
    ["192.0.0.0", 24, "ipv4"],
    ["192.168.0.0", 16, "ipv4"],
    ["198.18.0.0", 15, "ipv4"],
    ["224.0.0.0", 4, "ipv4"],
    ["240.0.0.0", 4, "ipv4"],
    ["::", 128, "ipv6"],
    ["::1", 128, "ipv6"],
    ["64:ff9b::", 96, "ipv6"],
    ["fc00::", 7, "ipv6"],
    ["fe80::", 10, "ipv6"],
    ["ff00::", 8, "ipv6"],
  ];
  for (const [network, prefix, family] of ranges) {
    list.addSubnet(network, prefix, family);
  }
  return list;
})();

/**
 * `::ffff:a.b.c.d` and `::ffff:aabb:ccdd` both name an IPv4 host inside an IPv6
 * address. Returns that IPv4 address, or null when the input is not mapped.
 */
function ipv4FromMapped(ip: string): string | null {
  const lower = ip.toLowerCase();
  if (!lower.startsWith("::ffff:")) {
    return null;
  }
  const body = ip.slice(7);
  if (isIP(body) === 4) {
    return body;
  }
  const groups = body.split(":");
  if (groups.length !== 2) {
    return null;
  }
  const high = Number.parseInt(groups[0] as string, 16);
  const low = Number.parseInt(groups[1] as string, 16);
  if (!Number.isInteger(high) || !Number.isInteger(low) || high > 0xffff || low > 0xffff) {
    return null;
  }
  return [high >> 8, high & 0xff, low >> 8, low & 0xff].join(".");
}

/**
 * True when the address must not be dialled. Anything that is not an IP at all
 * counts as blocked: we cannot reason about it, and failing closed is the whole
 * point of this module.
 */
export function isBlockedAddress(ip: string): boolean {
  const bare = ip.startsWith("[") && ip.endsWith("]") ? ip.slice(1, -1) : ip;
  // A zone index (`fe80::1%eth0`) identifies an interface, not a range.
  const address = bare.split("%")[0] as string;
  if (address === "") {
    return true;
  }
  if (isIP(address) === 4) {
    return NON_PUBLIC.check(address, "ipv4");
  }
  if (isIP(address) === 6) {
    // An IPv4-mapped address is an IPv4 host; judge it by the IPv4 ranges.
    const mapped = ipv4FromMapped(address);
    return mapped === null ? NON_PUBLIC.check(address, "ipv6") : NON_PUBLIC.check(mapped, "ipv4");
  }
  return true;
}

/**
 * A `dns.lookup` that resolves, then refuses if any address it resolved to is
 * non-public. Node calls this with `{all: true}` when `autoSelectFamily` is on
 * and expects an array back, and with a single address otherwise, so both
 * callback shapes are honoured.
 */
function guardedLookup(isBlocked: (ip: string) => boolean): http.RequestOptions["lookup"] {
  const lookup = (
    hostname: string,
    options: LookupOptions,
    callback: (
      err: NodeJS.ErrnoException | null,
      address: string | LookupAddress[],
      family?: number
    ) => void
  ): void => {
    dnsLookup(hostname, options, (err, address, family) => {
      if (err !== null) {
        callback(err, typeof address === "string" ? address : "", family);
        return;
      }
      const found: LookupAddress[] = Array.isArray(address)
        ? address
        : [{ address, family: family ?? 4 }];
      if (found.some((entry) => isBlocked(entry.address))) {
        const error: NodeJS.ErrnoException = new Error(NOT_ALLOWED);
        error.code = BLOCKED_CODE;
        if (Array.isArray(address)) {
          callback(error, []);
        } else {
          callback(error, "", 0);
        }
        return;
      }
      if (Array.isArray(address)) {
        callback(null, found);
      } else {
        callback(null, address, family);
      }
    });
  };
  return lookup as http.RequestOptions["lookup"];
}

/** What one response told us. `bytes` is null when the body was refused or unused. */
interface Hop {
  status: number;
  location: string | undefined;
  contentType: string | undefined;
  bytes: Buffer | null;
  tooLarge: boolean;
}

type Attempt = { ok: true; hop: Hop } | { ok: false; error: string };

/** One request, one response, with the body read under a byte cap. */
function requestOnce(
  url: URL,
  opts: PublicFetchOptions,
  isBlocked: (ip: string) => boolean
): Promise<Attempt> {
  return new Promise((resolve) => {
    const transport = url.protocol === "https:" ? https : http;
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const settle = (outcome: Attempt): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve(outcome);
    };

    const req = transport.request(
      url,
      { method: "GET", lookup: guardedLookup(isBlocked) },
      (res) => {
        const status = res.statusCode ?? 0;
        const header = (name: string): string | undefined => {
          const value = res.headers[name];
          return typeof value === "string" ? value : undefined;
        };
        const contentType = header("content-type");
        const location = header("location");

        // Nothing in a redirect body is used: drop the socket, do not drain it.
        if (REDIRECT_STATUSES.has(status) && location !== undefined) {
          res.destroy();
          settle({
            ok: true,
            hop: { status, location, contentType, bytes: null, tooLarge: false },
          });
          return;
        }

        const declared = Number(header("content-length"));
        if (Number.isFinite(declared) && declared > opts.maxBytes) {
          res.destroy();
          settle({
            ok: true,
            hop: { status, location: undefined, contentType, bytes: null, tooLarge: true },
          });
          return;
        }

        const chunks: Buffer[] = [];
        let total = 0;
        res.on("data", (chunk: Buffer) => {
          total += chunk.byteLength;
          if (total > opts.maxBytes) {
            settle({
              ok: true,
              hop: { status, location: undefined, contentType, bytes: null, tooLarge: true },
            });
            res.destroy();
            req.destroy();
            return;
          }
          chunks.push(chunk);
        });
        res.on("end", () => {
          settle({
            ok: true,
            hop: {
              status,
              location: undefined,
              contentType,
              bytes: Buffer.concat(chunks),
              tooLarge: false,
            },
          });
        });
        res.on("error", (err: Error) => {
          settle({ ok: false, error: `could not fetch media: ${err.message}` });
        });
      }
    );

    timer = setTimeout(() => {
      settle({ ok: false, error: `could not fetch media: timed out after ${opts.timeoutMs} ms` });
      req.destroy();
    }, opts.timeoutMs);

    req.on("error", (err: NodeJS.ErrnoException) => {
      // A refused address arrives as a request error raised inside `lookup`.
      settle({
        ok: false,
        error: err.code === BLOCKED_CODE ? NOT_ALLOWED : `could not fetch media: ${err.message}`,
      });
    });
    req.end();
  });
}

export interface PublicFetchOptions {
  maxBytes: number;
  timeoutMs: number;
  /** Test seam. Default: the non-public ranges listed above. */
  isBlocked?: (ip: string) => boolean;
}

export type PublicFetchResult =
  { ok: true; bytes: Uint8Array; mime: string } | { ok: false; error: string };

/**
 * Fetch `url`, refusing any address that is not on the public internet.
 *
 * Never throws: every failure comes back as `{ok: false, error}` so the caller
 * can hand the text straight to the agent that asked for the media.
 */
export async function fetchPublic(
  url: string,
  opts: PublicFetchOptions
): Promise<PublicFetchResult> {
  const isBlocked = opts.isBlocked ?? isBlockedAddress;

  let target: URL;
  try {
    target = new URL(url);
  } catch {
    return { ok: false, error: NOT_ALLOWED };
  }

  let redirects = 0;
  for (;;) {
    if (target.protocol !== "http:" && target.protocol !== "https:") {
      return { ok: false, error: NOT_ALLOWED };
    }
    // An IPv6 literal keeps its brackets in `URL.hostname`. Node never calls
    // `lookup` for an IP-literal host, so such a host is checked here instead.
    const host = target.hostname.replace(/^\[|\]$/g, "");
    if (isIP(host) !== 0 && isBlocked(host)) {
      return { ok: false, error: NOT_ALLOWED };
    }

    const attempt = await requestOnce(target, opts, isBlocked);
    if (!attempt.ok) {
      return attempt;
    }
    const hop = attempt.hop;

    if (REDIRECT_STATUSES.has(hop.status) && hop.location !== undefined) {
      if (redirects >= MAX_REDIRECTS) {
        return { ok: false, error: "too many redirects" };
      }
      redirects += 1;
      let next: URL;
      try {
        // Relative `Location` headers are legal and common.
        next = new URL(hop.location, target);
      } catch {
        return { ok: false, error: NOT_ALLOWED };
      }
      target = next;
      continue;
    }

    if (hop.status < 200 || hop.status > 299) {
      return { ok: false, error: `could not fetch media: HTTP ${hop.status}` };
    }
    if (hop.tooLarge) {
      return { ok: false, error: `media is larger than ${opts.maxBytes} bytes` };
    }
    const mime = (hop.contentType ?? "").split(";")[0]?.trim() ?? "";
    return {
      ok: true,
      bytes: new Uint8Array(hop.bytes ?? new Uint8Array()),
      mime: mime === "" ? DEFAULT_MIME : mime,
    };
  }
}
