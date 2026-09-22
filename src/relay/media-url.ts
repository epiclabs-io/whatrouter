/**
 * Public URL for a stored media object. The gateway fetches these URLs from
 * wherever it runs, so `public_url` is what makes inbound media work outside
 * localhost; falling back is loud (once) rather than silent.
 */
import type { Config } from '../config/schema.js';
import type { Logger } from '../util/log.js';

export interface MediaUrlOptions {
  /** The port actually bound (matters when `listen` uses port 0). */
  port?: number;
  log?: Logger;
}

let warned = false;

/** Test seam: lets a suite observe the one-time warning again. */
export function resetMediaUrlWarning(): void {
  warned = false;
}

/** `<public_url>` or `http://localhost:<port>`, without a trailing slash. */
export function mediaBaseUrl(config: Config, opts: MediaUrlOptions = {}): string {
  if (config.publicUrl !== null && config.publicUrl !== '') {
    return config.publicUrl.replace(/\/+$/, '');
  }
  const port = opts.port ?? config.listen.port;
  if (!warned) {
    warned = true;
    const message =
      'public_url is not set: media URLs fall back to http://localhost — a Hermes instance on another host will not be able to fetch them';
    if (opts.log !== undefined) opts.log.warn({ port }, message);
    else console.warn(`whatrouter: ${message}`);
  }
  return `http://localhost:${port}`;
}

export function mediaUrl(config: Config, id: string, opts: MediaUrlOptions = {}): string {
  return `${mediaBaseUrl(config, opts)}/relay/media/${id}`;
}
