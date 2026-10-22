// There is no specification for "OpenAI-compatible". There is only OpenAI's
// observed behaviour and the ways each other endpoint differs from it. So a
// probe does not pass or fail — it reports what it SAW, and whether that
// diverges from the reference behaviour. A divergence is not a bug on the
// provider's part; it is a thing your client code has to handle.

export type Verdict =
  | 'matches' // behaves like the reference
  | 'diverges' // works, but differently — your client must account for it
  | 'unsupported' // the endpoint rejects this outright
  | 'error' // the probe could not reach a conclusion (network, auth, billing)
  | 'skipped'; // not applicable to this target

export interface ProbeResult {
  probe: string;
  verdict: Verdict;
  /** One line, written for someone deciding whether their client breaks. */
  finding: string;
  /** Raw material backing the finding. Printed with --verbose, always in JSON. */
  evidence?: unknown;
  ms?: number;
}

/** How to talk to one endpoint. Everything that differs lives here. */
export interface Target {
  name: string;
  /** Resolved at run time so a missing key is reported, not thrown at import. */
  url: () => string;
  headers: () => Record<string, string>;
  /** Model used for probes unless overridden with --model. */
  defaultModel: string;
  /** Env vars that must be set for this target to be reachable. */
  requires: string[];
  /** Free-text note shown in the report (pricing, plan limits, caveats). */
  note?: string;
  /**
   * Ollama's OpenAI-compatible endpoint needs no auth and bills nothing, so it
   * is safe to hammer. Cloud targets are rate- and cost-bearing.
   */
  local?: boolean;
}

export interface ProbeContext {
  target: Target;
  model: string;
  /** Issues a chat/completions request and returns the raw Response. */
  post: (body: unknown, opts?: { stream?: boolean }) => Promise<Response>;
  verbose: boolean;
}

export interface Probe {
  name: string;
  /** What this probe is for, in terms of the client bug it prevents. */
  because: string;
  /** Roughly how many model calls it costs. Used by --dry-run and --max-calls. */
  calls: number;
  run: (ctx: ProbeContext) => Promise<ProbeResult>;
}

export interface TargetReport {
  target: string;
  model: string;
  reachable: boolean;
  results: ProbeResult[];
  startedAt: string;
}
