// A deliberately paranoid SSE reader.
//
// A normal client coerces, concatenates and discards. To report divergences we
// have to keep exactly what a normal client throws away:
//
//   - frames that are not `data:` lines at all (keepalive comments)
//   - the JSON type of delta.content BEFORE anything stringifies it
//   - whether the [DONE] sentinel ever arrived
//   - which chunk, if any, carried usage
//
// The numeric-content case is the reason this exists. At least one endpoint
// emits an unquoted JSON number when a chunk is purely numeric, so a reply
// beginning "1." yields the NUMBER 1. Concatenation hides it completely;
// any consumer calling .length or .slice() on the piece throws instead.

export interface RawFrame {
  /** The line as received, minus the trailing newline. */
  line: string;
  /** True for `data: ` lines; false for comments, blank lines, anything else. */
  isData: boolean;
}

export interface ContentDelta {
  /** typeof the raw value: 'string', 'number', 'object', … */
  jsType: string;
  value: unknown;
  /** Index of the chunk this came from. */
  chunk: number;
}

export interface SSECapture {
  frames: RawFrame[];
  /** Non-data, non-blank lines — keepalives and other interleaved noise. */
  comments: string[];
  deltas: ContentDelta[];
  /** Keys seen inside `delta` across all chunks, e.g. role, content, reasoning. */
  deltaKeys: Set<string>;
  sawDone: boolean;
  /** Usage object if one arrived, plus which chunk index carried it. */
  usage?: { value: Record<string, unknown>; chunk: number; isFinal: boolean };
  finishReasons: string[];
  /** Frames that were not valid JSON after the `data: ` prefix. */
  unparseable: string[];
  chunkCount: number;
  /** Time from request completion to the first content delta. */
  ttfbMs?: number;
}

export async function captureSSE(res: Response, startedAt: number): Promise<SSECapture> {
  const cap: SSECapture = {
    frames: [],
    comments: [],
    deltas: [],
    deltaKeys: new Set(),
    sawDone: false,
    finishReasons: [],
    unparseable: [],
    chunkCount: 0,
  };
  if (!res.body) return cap;

  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let lastIndex = -1;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split('\n');
    // The final element is a partial line; the next read completes it.
    buf = lines.pop() ?? '';

    for (const rawLine of lines) {
      const line = rawLine.replace(/\r$/, '');
      if (line.trim() === '') continue;
      const isData = line.startsWith('data:');
      cap.frames.push({ line, isData });
      if (!isData) {
        cap.comments.push(line);
        continue;
      }

      const payload = line.slice(line.indexOf(':') + 1).trim();
      if (payload === '[DONE]') {
        cap.sawDone = true;
        continue;
      }

      let parsed: any;
      try {
        parsed = JSON.parse(payload);
      } catch {
        cap.unparseable.push(payload.slice(0, 200));
        continue;
      }

      lastIndex = cap.chunkCount;
      cap.chunkCount++;

      const choice = parsed?.choices?.[0];
      const delta = choice?.delta;
      if (delta && typeof delta === 'object') {
        for (const k of Object.keys(delta)) cap.deltaKeys.add(k);
        if ('content' in delta && delta.content !== null && delta.content !== undefined) {
          cap.deltas.push({ jsType: typeof delta.content, value: delta.content, chunk: lastIndex });
          if (cap.ttfbMs === undefined) cap.ttfbMs = Date.now() - startedAt;
        }
      }
      if (choice?.finish_reason) cap.finishReasons.push(String(choice.finish_reason));
      if (parsed?.usage) {
        cap.usage = { value: parsed.usage, chunk: lastIndex, isFinal: true };
      }
    }
  }

  // `isFinal` is only true if nothing followed the usage-bearing chunk. Clients
  // that read usage on the last chunk break when it arrives mid-stream.
  if (cap.usage) cap.usage.isFinal = cap.usage.chunk === lastIndex;

  return cap;
}

/** What a normal client would end up with, for comparison in findings. */
export function concatenated(cap: SSECapture): string {
  return cap.deltas.map((d) => String(d.value)).join('');
}
