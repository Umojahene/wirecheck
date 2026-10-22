import type { Probe, ProbeResult } from '../types.ts';
import { errText, safeBody } from '../http.ts';
import { captureSSE, concatenated } from '../sse.ts';
import { postWithBudget } from './shared.ts';


/**
 * Asks for a reply that is purely numeric, then reports the JSON type of each
 * content delta.
 *
 * At least one endpoint emits an UNQUOTED JSON number when a chunk's content is
 * entirely numeric, so a reply opening with "1." yields the JavaScript number 1
 * rather than the string "1". Every tutorial client concatenates deltas, and
 * concatenation coerces, so this hides perfectly — until something calls
 * .length, .slice(), .trim() or .startsWith() on a piece and throws
 * "not a function" from inside a stream handler.
 */
export const numericChunk: Probe = {
  name: 'numeric-chunk',
  because: 'a non-string delta throws in any client that calls .length or .slice on a piece',
  calls: 1,
  run: async (ctx): Promise<ProbeResult> => {
    const t0 = Date.now();
    try {
      const r = await postWithBudget(
        ctx,
        {
          messages: [
            {
              role: 'user',
              content: 'Output exactly this and nothing else, no words: 1 2 3 4 5 6 7 8 9 10',
            },
          ],
        },
        64,
        { stream: true },
      );
      if (!r.res.ok) {
        return {
          probe: 'numeric-chunk',
          verdict: 'error',
          finding: `HTTP ${r.res.status}: ${await safeBody(r.res, 200)}`,
          ms: Date.now() - t0,
        };
      }
      const cap = await captureSSE(r.res, t0);
      const ms = Date.now() - t0;
      const types = [...new Set(cap.deltas.map((d) => d.jsType))];
      const nonString = cap.deltas.filter((d) => d.jsType !== 'string');
      const evidence = {
        deltaTypes: types,
        chunks: cap.chunkCount,
        nonStringSamples: nonString.slice(0, 5).map((d) => ({ chunk: d.chunk, jsType: d.jsType, value: d.value })),
        reconstructed: concatenated(cap).slice(0, 120),
      };
      if (nonString.length === 0) {
        return {
          probe: 'numeric-chunk',
          verdict: types.length ? 'matches' : 'error',
          finding: types.length
            ? `all ${cap.deltas.length} content deltas were strings`
            : 'no content deltas arrived — cannot judge',
          evidence,
          ms,
        };
      }
      return {
        probe: 'numeric-chunk',
        verdict: 'diverges',
        finding:
          `${nonString.length} of ${cap.deltas.length} content deltas were NOT strings ` +
          `(saw ${types.join(', ')}) — coerce with String() before touching a piece`,
        evidence,
        ms,
      };
    } catch (e) {
      return { probe: 'numeric-chunk', verdict: 'error', finding: errText(e), ms: Date.now() - t0 };
    }
  },
};

/**
 * Inspects the stream's framing rather than its content: interleaved keepalive
 * comments, and whether the `[DONE]` sentinel actually arrives.
 *
 * A client that assumes every non-blank line is a `data:` line will try to
 * JSON.parse a comment. A client that waits for `[DONE]` to resolve a promise
 * hangs forever against an endpoint that just closes the socket.
 */
export const streamFrames: Probe = {
  name: 'stream-frames',
  because: 'keepalive comments break naive parsers; a missing [DONE] hangs clients that await it',
  calls: 1,
  run: async (ctx): Promise<ProbeResult> => {
    const t0 = Date.now();
    try {
      const r = await postWithBudget(
        ctx,
        { messages: [{ role: 'user', content: 'Write one short sentence about rain.' }] },
        64,
        { stream: true },
      );
      if (!r.res.ok) {
        return {
          probe: 'stream-frames',
          verdict: 'error',
          finding: `HTTP ${r.res.status}: ${await safeBody(r.res, 200)}`,
          ms: Date.now() - t0,
        };
      }
      const cap = await captureSSE(r.res, t0);
      const ms = Date.now() - t0;
      const notes: string[] = [];
      if (cap.comments.length) {
        notes.push(`${cap.comments.length} non-data frame(s), e.g. ${JSON.stringify(cap.comments[0]?.slice(0, 48))}`);
      }
      if (!cap.sawDone) notes.push('no [DONE] sentinel');
      if (cap.unparseable.length) notes.push(`${cap.unparseable.length} unparseable data frame(s)`);
      const evidence = {
        chunks: cap.chunkCount,
        comments: cap.comments.slice(0, 5),
        sawDone: cap.sawDone,
        deltaKeys: [...cap.deltaKeys],
        ttfbMs: cap.ttfbMs,
        unparseable: cap.unparseable.slice(0, 3),
      };
      if (!notes.length) {
        return {
          probe: 'stream-frames',
          verdict: 'matches',
          finding: `clean framing: ${cap.chunkCount} data chunks, [DONE] present, no comments`,
          evidence,
          ms,
        };
      }
      return {
        probe: 'stream-frames',
        verdict: 'diverges',
        finding: notes.join('; '),
        evidence,
        ms,
      };
    } catch (e) {
      return { probe: 'stream-frames', verdict: 'error', finding: errText(e), ms: Date.now() - t0 };
    }
  },
};

/**
 * Streamed usage only arrives if you ask for it via stream_options, and not
 * every endpoint honours the request. Without it, every streamed call costs out
 * at a chars-per-token estimate instead of the real count.
 *
 * Also checks WHERE usage arrives. Clients commonly read it off the last chunk;
 * if it lands mid-stream, that read silently returns undefined.
 */
export const streamUsage: Probe = {
  name: 'stream-usage',
  because: 'without streamed usage every streaming cost figure is an estimate',
  calls: 1,
  run: async (ctx): Promise<ProbeResult> => {
    const t0 = Date.now();
    try {
      // Must negotiate the budget parameter rather than hardcoding max_tokens.
      // The first version of this probe did hardcode it, and on a model that
      // rejects max_tokens it read the resulting 400 as "rejects stream_options"
      // — a confident, wrong finding about a feature it had never reached.
      const r = await postWithBudget(
        ctx,
        {
          messages: [{ role: 'user', content: 'Say: ok' }],
          stream_options: { include_usage: true },
        },
        32,
        { stream: true },
      );
      const res = r.res;
      if (!res.ok) {
        const body = await safeBody(res, 300);
        const aboutStreamOptions = /stream_options|include_usage/i.test(body);
        return {
          probe: 'stream-usage',
          verdict: res.status === 400 && aboutStreamOptions ? 'unsupported' : 'error',
          finding:
            res.status === 400 && aboutStreamOptions
              ? `rejects stream_options with HTTP 400 — ${body.slice(0, 140)}`
              : `HTTP ${res.status} (not attributable to stream_options): ${body.slice(0, 140)}`,
          evidence: { status: res.status, body, budgetParam: r.param },
          ms: Date.now() - t0,
        };
      }
      const cap = await captureSSE(res, t0);
      const ms = Date.now() - t0;
      const evidence = {
        usage: cap.usage?.value,
        usageChunk: cap.usage?.chunk,
        usageOnFinalChunk: cap.usage?.isFinal,
        chunks: cap.chunkCount,
      };
      if (!cap.usage) {
        return {
          probe: 'stream-usage',
          verdict: 'diverges',
          finding: 'accepted stream_options.include_usage but sent no usage block',
          evidence,
          ms,
        };
      }
      if (!cap.usage.isFinal) {
        return {
          probe: 'stream-usage',
          verdict: 'diverges',
          finding:
            `usage arrived on chunk ${cap.usage.chunk} of ${cap.chunkCount - 1} — NOT the final ` +
            `chunk, so reading it off the last chunk yields undefined`,
          evidence,
          ms,
        };
      }
      return {
        probe: 'stream-usage',
        verdict: 'matches',
        finding: 'usage present on the final chunk',
        evidence,
        ms,
      };
    } catch (e) {
      return { probe: 'stream-usage', verdict: 'error', finding: errText(e), ms: Date.now() - t0 };
    }
  },
};

/**
 * Looks for a field carrying the model's internal reasoning alongside content.
 *
 * This is a safety-relevant divergence, not a cosmetic one. If an endpoint ships
 * `delta.reasoning` and your client renders every string it finds in the delta,
 * you will publish the model's private scratchpad to your users. The fix is to
 * read `delta.content` by name and never iterate the delta object — but you have
 * to know the field is there to decide that.
 */
export const reasoningLeak: Probe = {
  name: 'reasoning-leak',
  because: 'a client that renders the whole delta publishes the model\'s private thinking',
  calls: 1,
  run: async (ctx): Promise<ProbeResult> => {
    const t0 = Date.now();
    try {
      const r = await postWithBudget(
        ctx,
        {
          messages: [
            { role: 'user', content: 'If 3 pumps fill 2 tanks in 6 hours, how long for 1 pump and 1 tank?' },
          ],
        },
        256,
        { stream: true },
      );
      if (!r.res.ok) {
        return {
          probe: 'reasoning-leak',
          verdict: 'error',
          finding: `HTTP ${r.res.status}`,
          ms: Date.now() - t0,
        };
      }
      const cap = await captureSSE(r.res, t0);
      const ms = Date.now() - t0;
      const keys = [...cap.deltaKeys];
      const thinking = keys.filter((k) => /reason|think|thought|analysis/i.test(k));
      const evidence = { deltaKeys: keys, thinkingKeys: thinking };
      if (!thinking.length) {
        return {
          probe: 'reasoning-leak',
          verdict: 'matches',
          finding: `no thinking field in delta (saw: ${keys.join(', ') || 'none'})`,
          evidence,
          ms,
        };
      }
      return {
        probe: 'reasoning-leak',
        verdict: 'diverges',
        finding:
          `delta carries ${thinking.join(', ')} alongside content — read content by name, ` +
          `never iterate the delta`,
        evidence,
        ms,
      };
    } catch (e) {
      return { probe: 'reasoning-leak', verdict: 'error', finding: errText(e), ms: Date.now() - t0 };
    }
  },
};
