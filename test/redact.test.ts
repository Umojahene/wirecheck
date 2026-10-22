// Redaction is the one part of this tool where a bug is actively harmful: the
// output is meant to be pasted into issues and pull requests. These tests are
// deliberately paranoid, and they assert on what must NOT survive.

import { expect, test, describe } from 'bun:test';
import { redact, redactDeep } from '../src/http.ts';

describe('redact', () => {
  test('strips bearer tokens', () => {
    const out = redact('Authorization: Bearer sk-proj-AbCd1234EfGh5678IjKl');
    expect(out).not.toContain('AbCd1234');
    expect(out).toContain('[redacted]');
  });

  test('strips bare keys by common prefix', () => {
    for (const key of [
      'sk-abcdefgh12345678',
      'gsk-abcdefgh12345678',
      'xai-abcdefgh12345678',
      'or-abcdefgh12345678',
    ]) {
      expect(redact(`key is ${key} ok`)).not.toContain('abcdefgh12345678');
    }
  });

  test('strips long hex strings, which is what account ids look like', () => {
    const acct = 'a'.repeat(32);
    expect(redact(`/accounts/${acct}/ai/v1`)).not.toContain(acct);
  });

  test('strips values of key-shaped JSON fields', () => {
    const out = redact('{"api_key":"hunter2salted","model":"gpt-4o-mini"}');
    expect(out).not.toContain('hunter2salted');
    // Non-secret context must survive, or findings become unreadable.
    expect(out).toContain('gpt-4o-mini');
  });

  test('leaves ordinary findings untouched', () => {
    const finding = 'rejects max_tokens with HTTP 400 — requires max_completion_tokens';
    expect(redact(finding)).toBe(finding);
  });
});

describe('redactDeep', () => {
  test('blanks key-named fields anywhere in an evidence object', () => {
    const out = redactDeep({
      status: 400,
      headers: { Authorization: 'Bearer sk-live-1234567890' },
      nested: [{ api_key: 'abcdefghijkl' }],
    }) as any;
    expect(JSON.stringify(out)).not.toContain('sk-live-1234567890');
    expect(JSON.stringify(out)).not.toContain('abcdefghijkl');
    expect(out.status).toBe(400);
  });

  test('preserves numbers, nulls and booleans', () => {
    const out = redactDeep({ a: 1, b: null, c: true, d: [1, 2] }) as any;
    expect(out).toEqual({ a: 1, b: null, c: true, d: [1, 2] });
  });
});
