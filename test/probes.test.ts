// Probes are tested against a stub endpoint, which is the only way to assert
// the interesting cases: an endpoint at zero balance, one that returns 200 with
// empty content, one that renames the system role. Live endpoints do these on
// their own schedule, not on the test suite's.

import { expect, test, describe } from 'bun:test';
import type { ProbeContext, Target } from '../src/types.ts';
import { tokenParam, unknownParam, systemRole } from '../src/probes/params.ts';
import { emptyContent } from '../src/probes/content.ts';
import { errorShapeProbe } from '../src/probes/errors.ts';
import { runTarget, preflight } from '../src/run.ts';
import { PROBES } from '../src/probes/index.ts';

const target: Target = {
  name: 'stub',
  url: () => 'http://stub.invalid/v1/chat/completions',
  headers: () => ({}),
  defaultModel: 'stub-model',
  requires: [],
  local: true,
};

type Handler = (body: any) => Response;

function ctxWith(handler: Handler): ProbeContext {
  return {
    target,
    model: 'stub-model',
    verbose: false,
    post: async (body) => handler(body as any),
  };
}

const json = (obj: unknown, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });

const reply = (content: unknown, extra: Record<string, unknown> = {}) =>
  json({ choices: [{ message: { content }, finish_reason: 'stop' }], ...extra });

describe('token-param', () => {
  test('reports a match when max_tokens is accepted', async () => {
    const r = await tokenParam.run(ctxWith(() => reply('ok')));
    expect(r.verdict).toBe('matches');
  });

  test('reports divergence when max_tokens is rejected and the newer name works', async () => {
    const r = await tokenParam.run(
      ctxWith((body) =>
        'max_tokens' in body
          ? json({ error: { message: "Unsupported parameter: 'max_tokens'" } }, 400)
          : reply('ok'),
      ),
    );
    expect(r.verdict).toBe('diverges');
    expect(r.finding).toContain('max_completion_tokens');
  });
});

describe('unknown-param', () => {
  // Corrected after measuring the reference: strict IS the reference behaviour.
  test('a 400 on an unknown field matches the reference', async () => {
    const r = await unknownParam.run(
      ctxWith((body) =>
        'wirecheck_unknown_field' in body
          ? json({ error: { message: 'Unrecognized request argument supplied' } }, 400)
          : reply('ok'),
      ),
    );
    expect(r.verdict).toBe('matches');
  });

  test('silently ignoring an unknown field is the divergence', async () => {
    const r = await unknownParam.run(ctxWith(() => reply('ok')));
    expect(r.verdict).toBe('diverges');
    expect(r.finding).toContain('IGNORES');
  });
});

describe('system-role', () => {
  test('names the developer role when system is rejected but developer works', async () => {
    const r = await systemRole.run(
      ctxWith((body) => {
        const roles = body.messages.map((m: any) => m.role);
        if (roles.includes('system')) return json({ error: { message: 'unsupported role' } }, 400);
        return reply('WIRECHECK7');
      }),
    );
    expect(r.verdict).toBe('diverges');
    expect(r.finding).toContain('developer');
  });

  test('reports unsupported when neither role is accepted', async () => {
    const r = await systemRole.run(ctxWith(() => json({ error: 'no' }, 400)));
    expect(r.verdict).toBe('unsupported');
  });

  test('distinguishes accepted-but-not-honoured from honoured', async () => {
    const honoured = await systemRole.run(ctxWith(() => reply('WIRECHECK7')));
    expect(honoured.verdict).toBe('matches');
    const ignored = await systemRole.run(ctxWith(() => reply('Hello! How can I help?')));
    expect(ignored.verdict).toBe('diverges');
    expect(ignored.finding).toContain('did NOT honour');
  });
});

describe('empty-content', () => {
  test('catches HTTP 200 with an empty string', async () => {
    const r = await emptyContent.run(
      ctxWith(() =>
        json({
          choices: [{ message: { content: '' }, finish_reason: 'length' }],
          usage: { completion_tokens: 16, completion_tokens_details: { reasoning_tokens: 16 } },
        }),
      ),
    );
    expect(r.verdict).toBe('diverges');
    expect(r.finding).toContain('EMPTY');
    expect(r.finding).toContain('reasoning_tokens=16');
  });

  test('treats whitespace-only content as empty', async () => {
    const r = await emptyContent.run(
      ctxWith(() => json({ choices: [{ message: { content: '  \n ' }, finish_reason: 'length' }] })),
    );
    expect(r.verdict).toBe('diverges');
  });

  test('treats a null content field as empty', async () => {
    const r = await emptyContent.run(
      ctxWith(() => json({ choices: [{ message: { content: null }, finish_reason: 'length' }] })),
    );
    expect(r.verdict).toBe('diverges');
  });

  test('reports a match when real content comes back', async () => {
    const r = await emptyContent.run(ctxWith(() => reply('3')));
    expect(r.verdict).toBe('matches');
  });
});

describe('error-shape', () => {
  test('canonical 404 with a nested error object matches', async () => {
    const r = await errorShapeProbe.run(
      ctxWith(() => json({ error: { code: 'x', message: 'no such model', param: null, type: 'y' } }, 404)),
    );
    expect(r.verdict).toBe('matches');
  });

  test('an errors array diverges', async () => {
    const r = await errorShapeProbe.run(
      ctxWith(() => json({ errors: [{ message: 'nope', code: 7000 }] }, 400)),
    );
    expect(r.verdict).toBe('diverges');
    expect(r.finding).toContain('errors');
  });

  test('a 200 for a nonexistent model is itself a divergence', async () => {
    const r = await errorShapeProbe.run(ctxWith(() => reply('sure thing')));
    expect(r.verdict).toBe('diverges');
    expect(r.finding).toContain('fail silently');
  });
});

describe('preflight', () => {
  // The regression test for the worst bug this tool has had: run against two
  // accounts at zero balance it reported eleven confident findings from
  // endpoints that had not processed a single request.
  for (const status of [401, 402, 403, 429]) {
    test(`HTTP ${status} is account state, not endpoint behaviour`, async () => {
      const result = await preflight(
        async () => json({ error: { message: 'Insufficient Balance' } }, status),
        'stub-model',
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toContain(String(status));
    });
  }

  test('a 400 about max_tokens still counts as reachable', async () => {
    // The endpoint read the body and objected to it — that is a live endpoint,
    // and the probes below are exactly what should run next.
    const result = await preflight(
      async () => json({ error: { message: "Unsupported parameter: 'max_tokens'" } }, 400),
      'stub-model',
    );
    expect(result.ok).toBe(true);
  });

  test('a 200 counts as reachable', async () => {
    const result = await preflight(async () => reply('hi'), 'stub-model');
    expect(result.ok).toBe(true);
  });

  test('a 500 counts as reachable — server fault, not account state', async () => {
    const result = await preflight(async () => json({ error: 'boom' }, 500), 'stub-model');
    expect(result.ok).toBe(true);
  });

  test('an unresolvable host yields unreachable, not a wall of divergences', async () => {
    const report = await runTarget(target, PROBES, { verbose: false });
    expect(report.reachable).toBe(false);
    expect(report.results.every((r) => r.verdict === 'skipped')).toBe(true);
    expect(report.results.length).toBe(PROBES.length);
  });

  test('a missing env var is reported as missing, with no calls attempted', async () => {
    const needsKey: Target = { ...target, requires: ['WIRECHECK_DEFINITELY_UNSET'] };
    const report = await runTarget(needsKey, PROBES, { verbose: false });
    expect(report.reachable).toBe(false);
    expect(report.results[0]?.finding).toContain('WIRECHECK_DEFINITELY_UNSET');
  });
});
