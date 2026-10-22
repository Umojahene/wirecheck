import type { Probe, ProbeResult } from '../types.ts';
import { safeBody, errText } from '../http.ts';
import { TINY_PROMPT, postWithBudget, errorMessage } from './shared.ts';

/**
 * The divergence that bites first, and the one most people hit in production
 * rather than in development: on newer OpenAI reasoning models `max_tokens` is
 * not ignored, it is a hard 400. Code that worked against every other
 * OpenAI-compatible endpoint stops working the day you change model string.
 */
export const tokenParam: Probe = {
  name: 'token-param',
  because: 'a client that sends max_tokens gets a 400, not a truncation, on some models',
  calls: 1,
  run: async (ctx): Promise<ProbeResult> => {
    const t0 = Date.now();
    try {
      const r = await postWithBudget(ctx, { messages: TINY_PROMPT }, 24);
      const ms = Date.now() - t0;
      if (!r.retried) {
        return {
          probe: 'token-param',
          verdict: 'matches',
          finding: `accepts max_tokens (HTTP ${r.res.status})`,
          evidence: { status: r.res.status },
          ms,
        };
      }
      return {
        probe: 'token-param',
        verdict: 'diverges',
        finding:
          `rejects max_tokens with HTTP 400 — requires max_completion_tokens ` +
          `(retry status ${r.res.status})`,
        evidence: { rejectedBody: r.firstBody, retryStatus: r.res.status },
        ms,
      };
    } catch (e) {
      return { probe: 'token-param', verdict: 'error', finding: errText(e), ms: Date.now() - t0 };
    }
  },
};

/**
 * Whether unknown fields are ignored or rejected decides if you can write one
 * request builder for all providers.
 *
 * ⚠ CORRECTED 2026-10-22. This probe was written asserting that OpenAI ignores
 * unknown top-level fields and that stricter endpoints were the divergent ones.
 * Measured against gpt-4o-mini, the reference REJECTS them:
 * `HTTP 400 Unrecognized request argument supplied`. So strict is the reference
 * behaviour and permissive is the divergence — which is the safer way round
 * anyway, since a provider that silently swallows a field you believe is in
 * effect will not tell you it was ignored.
 */
export const unknownParam: Probe = {
  name: 'unknown-param',
  because: 'decides whether one request body can be reused across providers',
  calls: 1,
  run: async (ctx): Promise<ProbeResult> => {
    const t0 = Date.now();
    try {
      const res = await ctx.post({
        model: ctx.model,
        messages: TINY_PROMPT,
        max_tokens: 24,
        // Deliberately meaningless and clearly namespaced.
        wirecheck_unknown_field: { probe: true },
      });
      const ms = Date.now() - t0;
      if (res.ok) {
        return {
          probe: 'unknown-param',
          verdict: 'diverges',
          finding:
            'silently IGNORES unknown top-level fields (reference rejects them with 400) — ' +
            'a field you believe is in effect may not be',
          evidence: { status: res.status },
          ms,
        };
      }
      const body = await safeBody(res);
      let msg: string | undefined;
      try {
        msg = errorMessage(JSON.parse(body));
      } catch {
        /* non-JSON error body; the raw text is the evidence */
      }
      const strict = res.status === 400;
      return {
        probe: 'unknown-param',
        verdict: strict ? 'matches' : 'diverges',
        finding:
          `rejects unknown fields with HTTP ${res.status}` +
          `${strict ? '' : ' (reference uses 400)'}` +
          `${msg ? ` — ${String(msg).slice(0, 120)}` : ''}`,
        evidence: { status: res.status, body },
        ms,
      };
    } catch (e) {
      return { probe: 'unknown-param', verdict: 'error', finding: errText(e), ms: Date.now() - t0 };
    }
  },
};

/**
 * Not every endpoint supports a `system` role, and the ones that don't vary in
 * how they fail: some 400, some silently drop it. A silently dropped system
 * prompt is the worst outcome available — the agent simply stops following its
 * instructions, with nothing logged anywhere.
 */
export const systemRole: Probe = {
  name: 'system-role',
  because: 'a silently dropped system prompt makes an agent ignore its instructions',
  calls: 3,
  run: async (ctx): Promise<ProbeResult> => {
    const t0 = Date.now();
    const canary = 'WIRECHECK7';
    try {
      const res = await ctx.post({
        model: ctx.model,
        messages: [
          { role: 'system', content: `You must reply with exactly this token and nothing else: ${canary}` },
          { role: 'user', content: 'Go.' },
        ],
        max_tokens: 24,
      });
      if (!res.ok) {
        const body = await safeBody(res);
        // Newer OpenAI reasoning models replaced `system` with `developer`.
        // Reporting only "rejected" would leave the reader with a dead end, so
        // the probe spends one more call finding out whether the replacement
        // works and says which name to use.
        //
        // The budget parameter is negotiated rather than hardcoded: an endpoint
        // that rejects `system` for some unrelated reason would otherwise fail
        // this retry on the parameter name and be reported as supporting
        // neither role.
        const altR = await postWithBudget(
          ctx,
          {
            messages: [
              { role: 'developer', content: `You must reply with exactly this token and nothing else: ${canary}` },
              { role: 'user', content: 'Go.' },
            ],
          },
          24,
        );
        const alt = altR.res;
        const ms2 = Date.now() - t0;
        if (alt.ok) {
          return {
            probe: 'system-role',
            verdict: 'diverges',
            finding:
              `rejects role "system" with HTTP ${res.status}, but accepts role "developer" ` +
              `— rename the role for this model`,
            evidence: { systemStatus: res.status, developerStatus: alt.status, body },
            ms: ms2,
          };
        }
        return {
          probe: 'system-role',
          verdict: 'unsupported',
          finding: `rejects role "system" (HTTP ${res.status}) and role "developer" (HTTP ${alt.status})`,
          evidence: { systemStatus: res.status, developerStatus: alt.status, body },
          ms: ms2,
        };
      }
      const ms = Date.now() - t0;
      const data: any = await res.json().catch(() => null);
      const text: string = data?.choices?.[0]?.message?.content ?? '';
      const honoured = text.includes(canary);
      return {
        probe: 'system-role',
        verdict: honoured ? 'matches' : 'diverges',
        finding: honoured
          ? 'accepts the system role and honoured it'
          : 'accepted the system role but did NOT honour it (instruction-following, not transport)',
        evidence: { reply: text.slice(0, 160) },
        ms,
      };
    } catch (e) {
      return { probe: 'system-role', verdict: 'error', finding: errText(e), ms: Date.now() - t0 };
    }
  },
};
