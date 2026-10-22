import type { ProbeContext } from '../types.ts';
import { safeBody } from '../http.ts';

/** Kept tiny on purpose: these run against metered endpoints and slow local ones. */
export const TINY_PROMPT = [{ role: 'user', content: 'Say the word: ok' }];

export interface BudgetedResult {
  res: Response;
  /** Which parameter name the endpoint actually accepted. */
  param: 'max_tokens' | 'max_completion_tokens';
  /** True if max_tokens was rejected and the newer name had to be used. */
  retried: boolean;
  firstStatus: number;
  firstBody?: string;
}

/**
 * Sends a request with a token budget, coping with the fact that newer OpenAI
 * reasoning models reject `max_tokens` outright (HTTP 400) rather than ignoring
 * it. This is what a real client has to do, so doing it here keeps every other
 * probe honest — and the return value tells the token-param probe what it saw.
 */
export async function postWithBudget(
  ctx: ProbeContext,
  body: Record<string, unknown>,
  budget: number,
  opts: { stream?: boolean } = {},
): Promise<BudgetedResult> {
  const first = await ctx.post({ ...body, model: ctx.model, max_tokens: budget }, opts);
  if (first.status !== 400) {
    return { res: first, param: 'max_tokens', retried: false, firstStatus: first.status };
  }
  const firstBody = await safeBody(first);
  const res = await ctx.post(
    { ...body, model: ctx.model, max_completion_tokens: budget },
    opts,
  );
  return {
    res,
    param: 'max_completion_tokens',
    retried: true,
    firstStatus: 400,
    firstBody,
  };
}

/** Pulls a message string out of whatever error envelope the provider uses. */
export function errorMessage(parsed: any): string | undefined {
  return (
    parsed?.error?.message ??
    parsed?.error ??
    parsed?.message ??
    parsed?.detail ??
    (Array.isArray(parsed?.errors) ? parsed.errors[0]?.message : undefined)
  );
}

/** Describes the shape of an error envelope without quoting its contents. */
export function errorShape(parsed: any): string {
  if (parsed == null) return 'non-JSON body';
  if (typeof parsed !== 'object') return typeof parsed;
  const keys = Object.keys(parsed).sort();
  if (parsed.error && typeof parsed.error === 'object') {
    return `{ error: { ${Object.keys(parsed.error).sort().join(', ')} } }`;
  }
  if (Array.isArray(parsed.errors)) return '{ errors: [ … ] }';
  return `{ ${keys.join(', ')} }`;
}
