import { describe, expect, it } from 'vitest';
import { asciiFilename, contentDisposition } from '../../src/relay/content-disposition.js';
import { validateHeaderValue } from 'node:http';

describe('asciiFilename', () => {
  it('keeps printable ASCII names unchanged', () => {
    expect(asciiFilename('annual-report-2026.pdf')).toBe('annual-report-2026.pdf');
  });

  it('replaces non-ASCII characters with underscores', () => {
    expect(asciiFilename('r\u00e9sum\u00e9-2026.pdf')).toBe('r_sum_-2026.pdf');
    expect(asciiFilename('\u4e2d\u6587\u62a5\u544a.pdf')).toBe('____.pdf');
  });

  it('removes quote, backslash and control characters', () => {
    expect(asciiFilename('bad"quote.pdf')).toBe('badquote.pdf');
    expect(asciiFilename('bad\\slash.pdf')).toBe('badslash.pdf');
    expect(asciiFilename('line\nbreak.pdf')).toBe('linebreak.pdf');
    expect(asciiFilename('nul\u0000name.pdf')).toBe('nulname.pdf');
  });

  it('bounds the result to 200 characters', () => {
    expect(asciiFilename('a'.repeat(250))).toHaveLength(200);
  });
});

describe('contentDisposition', () => {
  it('returns an ASCII-only quoted filename for an ASCII name', () => {
    expect(contentDisposition('annual-report-2026.pdf', 'fallback-id')).toBe(
      'inline; filename="annual-report-2026.pdf"; filename*=UTF-8\'\'annual-report-2026.pdf',
    );
  });

  it('falls back when the name is empty or null', () => {
    expect(contentDisposition('', 'media-id')).toBe(
      'inline; filename="media-id"; filename*=UTF-8\'\'media-id',
    );
    expect(contentDisposition(null, 'media-id')).toBe(
      'inline; filename="media-id"; filename*=UTF-8\'\'media-id',
    );
  });

  it('produces a Node-header-valid value for every problematic class of name', () => {
    const cases = [
      'annual-report-2026.pdf',
      'r\u00e9sum\u00e9 \u2014 draft.pdf',
      '\u4e2d\u6587\u62a5\u544a.pdf',
      'bad"quote\\and\nnewline.pdf',
      'dir/with/subpath.pdf',
    ];
    for (const name of cases) {
      const value = contentDisposition(name, 'media-id');
      expect(() => validateHeaderValue('content-disposition', value)).not.toThrow();
      expect(value).toMatch(/^inline; filename="[\x20-\x7e]*"; filename\*=UTF-8''/);
    }
  });

  it('percent-encodes the RFC 5987 parameter without unencoded delimiters', () => {
    const value = contentDisposition('a (b) c\'s.pdf', 'media-id');
    const encoded = value.split("filename*=UTF-8''")[1];
    expect(encoded).not.toMatch(/['()]/);
  });
});