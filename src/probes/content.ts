import type { Probe, ProbeResult } from '../types.ts';
import { errText } from '../http.ts';
import { postWithBudget } from './shared.ts';

/**
 * The flagship probe, because this failure is invisible.
 *
 * Reasoning models bill internal thinking against the OUTPUT budget. Give one a
 * budget that is merely tight and it returns HTTP 200, `finish_reason: "length"`
 * and an EMPTY content string — the thinking consumed the allowance and there
 * was nothing left to say. Nothing errors. A client that trusts the status code
 * renders a blank panel, logs nothing, and cannot fall back because as far as it
 * knows the call succeeded.
 *
 * It is worth knowing which of your endpoints can do this, because the only
 * robust client response is to treat empty content as a thrown error.
 */
export const emptyContent: Probe = {
  name: 'empty-content',
  because: 'a 200 with empty content cannot be distinguished from success by status code',
  calls: 1,
  run: async (ctx): Promise<ProbeResult> => {
    const t0 = Date.now();
    // Small enough that a reasoning model spends it all thinking, large enough
    // that a non-reasoning model returns a few real words.
    const BUDGET = 16;
    try {
      const r = await postWithBudget(
        ctx,
        {
          messages: [
            {
              role: 'user',
              content:
                'A barn holds chickens and sheep. There are 7 heads and 22 legs. ' +
                'How many sheep? Reply with just the number.',
            },
          ],
        },
        BUDGET,
      );
      const ms = Date.now() - t0;
      if (!r.res.ok) {
        return {
          probe: 'empty-content',
          verdict: 'error',
          finding: `HTTP ${r.res.status} — budget probe could not run`,
          ms,
        };
      }
      const data: any = await r.res.json().catch(() => null);
      const choice = data?.choices?.[0];
      const text: unknown = choice?.message?.content;
      const reasoningTokens = data?.usage?.completion_tokens_details?.reasoning_tokens;
      const evidence = {
        budget: BUDGET,
        param: r.param,
        finish_reason: choice?.finish_reason,
        contentType: typeof text,
        contentLength: typeof text === 'string' ? text.length : null,
        reasoning_tokens: reasoningTokens,
        completion_tokens: data?.usage?.completion_tokens,
      };

      const empty = typeof text !== 'string' || text.trim() === '';
      if (!empty) {
        return {
          probe: 'empty-content',
          verdict: 'matches',
          finding:
            `returned content at a ${BUDGET}-token budget ` +
            `(finish_reason=${choice?.finish_reason})`,
          evidence,
          ms,
        };
      }
      return {
        probe: 'empty-content',
        verdict: 'diverges',
        finding:
          `HTTP 200 with EMPTY content at a ${BUDGET}-token budget ` +
          `(finish_reason=${choice?.finish_reason}` +
          `${reasoningTokens === undefined ? '' : `, reasoning_tokens=${reasoningTokens}`}) ` +
          `— treat empty content as an error, not a success`,
        evidence,
        ms,
      };
    } catch (e) {
      return { probe: 'empty-content', verdict: 'error', finding: errText(e), ms: Date.now() - t0 };
    }
  },
};

/**
 * `finish_reason` is a string your routing logic probably branches on, and the
 * vocabulary is not standardised. Truncation is reported as `length` by OpenAI
 * but other endpoints use other words, so a `=== 'length'` check silently stops
 * detecting truncation when you add a provider.
 */
export const finishReason: Probe = {
  name: 'finish-reason',
  because: 'branching on finish_reason === "length" breaks on endpoints that word it differently',
  calls: 1,
  run: async (ctx): Promise<ProbeResult> => {
    const t0 = Date.now();
    try {
      const r = await postWithBudget(
        ctx,
        { messages: [{ role: 'user', content: 'Count slowly from 1 to 200, one number per line.' }] },
        24,
      );
      const ms = Date.now() - t0;
      if (!r.res.ok) {
        return {
          probe: 'finish-reason',
          verdict: 'error',
          finding: `HTTP ${r.res.status}`,
          ms,
        };
      }
      const data: any = await r.res.json().catch(() => null);
      const reason = data?.choices?.[0]?.finish_reason;
      const evidence = { finish_reason: reason, usage: data?.usage };
      if (reason === 'length') {
        return {
          probe: 'finish-reason',
          verdict: 'matches',
          finding: 'reports truncation as finish_reason="length"',
          evidence,
          ms,
        };
      }
      return {
        probe: 'finish-reason',
        verdict: 'diverges',
        finding: `reports truncation as finish_reason=${JSON.stringify(reason)}, not "length"`,
        evidence,
        ms,
      };
    } catch (e) {
      return { probe: 'finish-reason', verdict: 'error', finding: errText(e), ms: Date.now() - t0 };
    }
  },
};

/**
 * Non-streaming usage accounting. If `prompt_tokens`/`completion_tokens` are
 * absent you are left estimating from string length, and every cost figure you
 * report downstream is a guess. Worth knowing which endpoints make you guess.
 */
export const usageFields: Probe = {
  name: 'usage-fields',
  because: 'a missing usage block means every cost number you report is an estimate',
  calls: 1,
  run: async (ctx): Promise<ProbeResult> => {
    const t0 = Date.now();
    try {
      const r = await postWithBudget(ctx, { messages: [{ role: 'user', content: 'Say: ok' }] }, 24);
      const ms = Date.now() - t0;
      if (!r.res.ok) {
        return { probe: 'usage-fields', verdict: 'error', finding: `HTTP ${r.res.status}`, ms };
      }
      const data: any = await r.res.json().catch(() => null);
      const usage = data?.usage;
      if (!usage || typeof usage !== 'object') {
        return {
          probe: 'usage-fields',
          verdict: 'diverges',
          finding: 'no usage block on a non-streaming reply — token counts must be estimated',
          evidence: { topLevelKeys: data ? Object.keys(data) : null },
          ms,
        };
      }
      const keys = Object.keys(usage).sort();
      const hasCore = 'prompt_tokens' in usage && 'completion_tokens' in usage;
      const extra = keys.filter(
        (k) => !['prompt_tokens', 'completion_tokens', 'total_tokens'].includes(k),
      );
      return {
        probe: 'usage-fields',
        verdict: hasCore ? 'matches' : 'diverges',
        finding: hasCore
          ? `usage present${extra.length ? `; also non-standard: ${extra.join(', ')}` : ''}`
          : `usage present but missing prompt_tokens/completion_tokens — has ${keys.join(', ')}`,
        evidence: { usage },
        ms,
      };
    } catch (e) {
      return { probe: 'usage-fields', verdict: 'error', finding: errText(e), ms: Date.now() - t0 };
    }
  },
};
