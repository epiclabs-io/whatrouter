/**
 * Content-Disposition helpers.
 *
 * Node's HTTP writer rejects every non-ASCII code point in a header value, so a
 * WhatsApp filename like "informe final.pdf" can never ride the wire verbatim.
 * The ASCII-safe quoted form below is the only thing naive clients (including
 * the Hermes relay media client, which greps for `filename=`) parse, so it must
 * stay a valid, complete filename; RFC 5987 carries the original name alongside.
 */

/** Header-injection-free, ASCII-only quoted-string value. */
export function asciiFilename(name: string): string {
  return name
    .replace(/[\r\n"\\]/g, "")
    .replace(/[/\\]/g, "_")

    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/[^\x20-\x7e]/g, "_")
    .trim()
    .slice(0, 200);
}

/**
 * Builds an inline Content-Disposition header value from a raw filename.
 *
 * The quoted `filename=` is ASCII-safe (non-ASCII runs collapse to `_`); the
 * RFC 5987 `filename*=UTF-8''...` parameter preserves the original Unicode name
 * for clients that understand it.
 */
export function contentDisposition(name: string | null, fallback: string): string {
  const ascii = name === null || name.trim() === "" ? fallback : asciiFilename(name);
  const quoted = ascii === "" ? fallback : ascii;
  const encoded = encodeURIComponent(name === null || name.trim() === "" ? fallback : name).replace(
    /['()]/g,
    (ch) => ({ "'": "%27", "(": "%28", ")": "%29" })[ch] ?? ch
  );
  return `inline; filename="${quoted}"; filename*=UTF-8''${encoded}`;
}
