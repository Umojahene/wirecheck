import type { Probe, ProbeContext, Target, TargetReport } from './types.ts';
import { makeCaller, errText, safeBody, BLOCKED_STATUSES, BLOCKED_REASON } from './http.ts';
import { missingEnv } from './targets.ts';

/**
 * One minimal call before any probe runs, purely to find out whether this
 * endpoint will process requests at all. If the account is unauthorised, out of
 * credit or rate limited, every probe below would "measure" the same billing
 * error and report it as endpoint behaviour. Spending one call to avoid eleven
 * false findings is the trade here.
 */
export async function preflight(
  post: (body: unknown) => Promise<Response>,
  model: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  try {
    const res = await post({ model, messages: [{ role: 'user', content: 'hi' }], max_tokens: 1 });
    if (BLOCKED_STATUSES.has(res.status)) {
      const body = await safeBody(res, 200);
      const reason = BLOCKED_REASON[res.status] ?? 'request refused before processing';
      // One line of the provider's own words is useful; a wall of truncated JSON
      // is not, and this string ends up in a published matrix.
      const quoted = body.replace(/\s+/g, ' ').slice(0, 90).trim();
      return { ok: false, reason: `HTTP ${res.status} ${reason} — ${quoted}…` };
    }
    // Any other status, including a 400 about max_tokens, means the endpoint is
    // live and reading request bodies. That is all preflight needs to know.
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: errText(e) };
  }
}

export interface RunOptions {
  model?: string;
  verbose: boolean;
  /** Hard ceiling on model calls per target. Probes beyond it are skipped. */
  maxCalls?: number;
  onProbeStart?: (probe: string) => void;
  onProbeDone?: (probe: string, verdict: string) => void;
}

export async function runTarget(
  target: Target,
  probes: Probe[],
  opts: RunOptions,
): Promise<TargetReport> {
  const model = opts.model || target.defaultModel;
  const report: TargetReport = {
    target: target.name,
    model,
    reachable: true,
    results: [],
    startedAt: new Date().toISOString(),
  };

  const missing = missingEnv(target);
  if (missing.length) {
    report.reachable = false;
    report.results = probes.map((p) => ({
      probe: p.name,
      verdict: 'skipped' as const,
      finding: `missing env: ${missing.join(', ')}`,
    }));
    return report;
  }

  const caller = makeCaller(target);
  const ctx: ProbeContext = {
    target,
    model,
    post: caller.post,
    verbose: opts.verbose,
  };

  const pre = await preflight(caller.post, model);
  if (!pre.ok) {
    report.reachable = false;
    report.results = probes.map((p) => ({
      probe: p.name,
      verdict: 'skipped' as const,
      finding: pre.reason,
    }));
    return report;
  }

  for (const probe of probes) {
    if (opts.maxCalls !== undefined && caller.calls() + probe.calls > opts.maxCalls) {
      report.results.push({
        probe: probe.name,
        verdict: 'skipped',
        finding: `--max-calls ${opts.maxCalls} reached`,
      });
      continue;
    }
    opts.onProbeStart?.(probe.name);
    let result;
    try {
      result = await probe.run(ctx);
    } catch (e) {
      // A probe must never take the run down with it.
      result = { probe: probe.name, verdict: 'error' as const, finding: errText(e) };
    }
    report.results.push(result);
    opts.onProbeDone?.(probe.name, result.verdict);
  }

  // A target whose every probe errored is almost certainly unreachable (bad key,
  // zero balance, endpoint down) rather than wildly divergent. Saying so stops
  // the matrix reading as though the provider failed eleven conformance checks.
  const conclusive = report.results.filter(
    (r) => r.verdict !== 'error' && r.verdict !== 'skipped',
  );
  if (conclusive.length === 0 && report.results.length > 0) report.reachable = false;

  return report;
}
