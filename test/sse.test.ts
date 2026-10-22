// The SSE reader is tested against hand-built streams rather than live
// endpoints, because the cases that matter are the ones a live endpoint only
// produces occasionally — a numeric chunk, a keepalive comment, usage landing
// mid-stream. Waiting for a provider to do those on cue is not a test strategy.
//
// Every fixture below is modelled on a frame shape observed in a real run; the
// provenance is noted where it is not obvious.

import { expect, test, describe } from 'bun:test';
import { captureSSE, concatenated } from '../src/sse.ts';

function streamOf(lines: string[]): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const enc = new TextEncoder();
      for (const l of lines) controller.enqueue(enc.encode(l));
      controller.close();
    },
  });
  return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
}

const chunk = (delta: unknown, extra: Record<string, unknown> = {}) =>
  `data: ${JSON.stringify({ choices: [{ delta, ...extra }] })}\n\n`;

describe('captureSSE', () => {
  test('reads a clean OpenAI-shaped stream', async () => {
    const cap = await captureSSE(
      streamOf([
        chunk({ role: 'assistant', content: '' }),
        chunk({ content: 'he' }),
        chunk({ content: 'llo' }),
        `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 2 } })}\n\n`,
        'data: [DONE]\n\n',
      ]),
      Date.now(),
    );
    expect(concatenated(cap)).toBe('hello');
    expect(cap.sawDone).toBe(true);
    expect(cap.comments).toEqual([]);
    expect(cap.finishReasons).toEqual(['stop']);
    expect(cap.usage?.isFinal).toBe(true);
    expect([...cap.deltaKeys].sort()).toEqual(['content', 'role']);
  });

  test('preserves the JS type of a numeric content delta', async () => {
    // Cloudflare Workers AI emits an unquoted JSON number when the chunk is
    // purely numeric. Confirmed live 2026-10-22: 4 of 8 deltas were numbers.
    const cap = await captureSSE(
      streamOf([chunk({ content: 1 }), chunk({ content: ' 2' }), 'data: [DONE]\n\n']),
      Date.now(),
    );
    expect(cap.deltas.map((d) => d.jsType)).toEqual(['number', 'string']);
    // Concatenation hides it completely — which is why clients never notice.
    expect(concatenated(cap)).toBe('1 2');
  });

  test('separates keepalive comments from data frames', async () => {
    // OpenRouter interleaves `: OPENROUTER PROCESSING` comments.
    const cap = await captureSSE(
      streamOf([
        ': OPENROUTER PROCESSING\n\n',
        chunk({ content: 'ok' }),
        ': OPENROUTER PROCESSING\n\n',
        'data: [DONE]\n\n',
      ]),
      Date.now(),
    );
    expect(cap.comments.length).toBe(2);
    expect(cap.chunkCount).toBe(1);
    expect(concatenated(cap)).toBe('ok');
  });

  test('flags usage that does not arrive on the final chunk', async () => {
    const cap = await captureSSE(
      streamOf([
        chunk({ content: 'a' }),
        `data: ${JSON.stringify({ choices: [{ delta: {} }], usage: { prompt_tokens: 1, completion_tokens: 1 } })}\n\n`,
        chunk({ content: 'b' }),
        'data: [DONE]\n\n',
      ]),
      Date.now(),
    );
    expect(cap.usage).toBeDefined();
    expect(cap.usage?.isFinal).toBe(false);
  });

  test('survives a frame split across two network reads', async () => {
    // The real reason the reader buffers. A chunk boundary mid-JSON must not
    // produce an unparseable frame.
    const whole = chunk({ content: 'split' });
    const at = Math.floor(whole.length / 2);
    const cap = await captureSSE(
      streamOf([whole.slice(0, at), whole.slice(at), 'data: [DONE]\n\n']),
      Date.now(),
    );
    expect(cap.unparseable).toEqual([]);
    expect(concatenated(cap)).toBe('split');
  });

  test('records unparseable data frames instead of throwing', async () => {
    const cap = await captureSSE(
      streamOf(['data: {not json\n\n', chunk({ content: 'ok' })]),
      Date.now(),
    );
    expect(cap.unparseable.length).toBe(1);
    expect(concatenated(cap)).toBe('ok');
  });

  test('notices a thinking field alongside content', async () => {
    const cap = await captureSSE(
      streamOf([chunk({ reasoning: 'let me think', content: '' }), chunk({ content: '42' })]),
      Date.now(),
    );
    expect([...cap.deltaKeys]).toContain('reasoning');
  });

  test('tolerates CRLF line endings', async () => {
    const cap = await captureSSE(
      streamOf([chunk({ content: 'x' }).replace(/\n/g, '\r\n'), 'data: [DONE]\r\n\r\n']),
      Date.now(),
    );
    expect(concatenated(cap)).toBe('x');
    expect(cap.sawDone).toBe(true);
    expect(cap.comments).toEqual([]);
  });

  test('handles a body-less response without throwing', async () => {
    const cap = await captureSSE(new Response(null, { status: 204 }), Date.now());
    expect(cap.deltas).toEqual([]);
    expect(cap.chunkCount).toBe(0);
  });
});
