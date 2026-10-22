import type { Probe, ProbeResult } from '../types.ts';
import { errText, safeBody } from '../http.ts';
import { TINY_PROMPT, errorMessage, errorShape } from './shared.ts';

/**
 * Sends a model name that cannot exist and reports the status code and the
 * SHAPE of the error envelope — never its contents, which can echo request
 * data back.
 *
 * This matters because fallback logic branches on errors. If you retry on 404
 * but one endpoint returns 400 for an unknown model, that provider's typo
 * becomes a hard outage instead of a fallback. And `error.message` is not
 * universal: some endpoints nest it, some return a bare string, some return an
 * array.
 */
export const errorShapeProbe: Probe = {
  name: 'error-shape',
  because: 'fallback logic branches on status and error.message, and neither is standardised',
  calls: 1,
  run: async (ctx): Promise<ProbeResult> => {
    const t0 = Date.now();
    const bogus = 'wirecheck-no-such-model-00000';
    try {
      const res = await ctx.post({ model: bogus, messages: TINY_PROMPT, max_tokens: 16 });
      const ms = Date.now() - t0;
      const body = await safeBody(res, 800);
      let parsed: any = null;
      try {
        parsed = JSON.parse(body);
      } catch {
        /* a non-JSON error body is itself a finding */
      }
      const shape = errorShape(parsed);
      const msg = errorMessage(parsed);
      const hasMessage = typeof msg === 'string' && msg.length > 0;
      const evidence = {
        status: res.status,
        shape,
        hasErrorMessage: hasMessage,
        messagePreview: hasMessage ? String(msg).slice(0, 160) : null,
      };

      if (res.ok) {
        return {
          probe: 'error-shape',
          verdict: 'diverges',
          finding: `HTTP ${res.status} OK for a nonexistent model — unknown models fail silently`,
          evidence,
          ms,
        };
      }
      const canonical = res.status === 404 && shape.startsWith('{ error: {') && hasMessage;
      return {
        probe: 'error-shape',
        verdict: canonical ? 'matches' : 'diverges',
        finding:
          `unknown model → HTTP ${res.status}, envelope ${shape}` +
          `${hasMessage ? '' : ', no readable error.message'}`,
        evidence,
        ms,
      };
    } catch (e) {
      return { probe: 'error-shape', verdict: 'error', finding: errText(e), ms: Date.now() - t0 };
    }
  },
};
