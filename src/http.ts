// Request plumbing, plus the one rule that matters for a tool whose output is
// meant to be pasted into issues: nothing that could be a credential is ever
// allowed into a finding, evidence blob or error message.

import type { Target } from './types.ts';

export const TIMEOUT_MS = Number(process.env.WIRECHECK_TIMEOUT_MS) || 120_000;

/**
 * Statuses that mean "your account, not your request". The endpoint never
 * looked at the body, so ANY conclusion drawn from such a response is false.
 *
 * This list exists because the first version of this tool did draw those
 * conclusions. Run against two accounts at zero balance it cheerfully reported
 * "accepts max_tokens (HTTP 402)" and "rejects the system role (HTTP 402)" —
 * eleven confident findings from an endpoint that had not processed a single
 * request. Exactly the failure this tool is built to detect, in the tool.
 */
export const BLOCKED_STATUSES = new Set([401, 402, 403, 407, 429]);

export const BLOCKED_REASON: Record<number, string> = {
  401: 'unauthorised — key missing, wrong, or revoked',
  402: 'payment required — account has no balance or credits',
  403: 'forbidden — key lacks access to this endpoint or model',
  407: 'proxy authentication required',
  429: 'rate limited or quota exhausted',
};

/**
 * Redacts anything shaped like a key before it can reach stdout or a report.
 * Deliberately aggressive: a false positive costs a line of output, a false
 * negative publishes a secret.
 */
export function redact(input: string): string {
  return input
    .replace(/Bearer\s+[A-Za-z0-9._\-]+/gi, 'Bearer [redacted]')
    .replace(/\b(sk|rk|gsk|xai|or|pk)-[A-Za-z0-9._\-]{8,}/gi, '$1-[redacted]')
    .replace(/\b[A-Fa-f0-9]{32,}\b/g, '[redacted-hex]')
    .replace(
      /("?(?:api[_-]?key|authorization|token|secret|password)"?\s*[:=]\s*"?)([^",\s}]+)/gi,
      '$1[redacted]',
    );
}

/** Redacts recursively through an evidence object before it is serialised. */
export function redactDeep<T>(value: T): T {
  if (typeof value === 'string') return redact(value) as unknown as T;
  if (Array.isArray(value)) return value.map(redactDeep) as unknown as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = /key|auth|token|secret|password/i.test(k) ? '[redacted]' : redactDeep(v);
    }
    return out as unknown as T;
  }
  return value;
}

export interface Caller {
  post: (body: unknown, opts?: { stream?: boolean }) => Promise<Response>;
  calls: () => number;
}

export function makeCaller(target: Target, onCall?: () => void): Caller {
  let n = 0;
  return {
    calls: () => n,
    post: async (body, opts = {}) => {
      n++;
      onCall?.();
      const payload =
        opts.stream && body && typeof body === 'object'
          ? { ...(body as Record<string, unknown>), stream: true }
          : body;
      return fetch(target.url(), {
        method: 'POST',
        headers: target.headers(),
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    },
  };
}

/** Body text, truncated and redacted — safe to put in a finding. */
export async function safeBody(res: Response, limit = 600): Promise<string> {
  try {
    const text = await res.text();
    return redact(text).slice(0, limit);
  } catch {
    return '<unreadable body>';
  }
}

export function errText(e: unknown): string {
  const raw = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
  return redact(raw);
}
