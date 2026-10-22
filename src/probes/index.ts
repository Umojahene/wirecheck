import type { Probe } from '../types.ts';
import { tokenParam, unknownParam, systemRole } from './params.ts';
import { emptyContent, finishReason, usageFields } from './content.ts';
import { numericChunk, streamFrames, streamUsage, reasoningLeak } from './stream.ts';
import { errorShapeProbe } from './errors.ts';

// Order matters for readability of the report, not for correctness: no probe
// may depend on another having run.
export const PROBES: Probe[] = [
  tokenParam,
  unknownParam,
  systemRole,
  emptyContent,
  finishReason,
  usageFields,
  numericChunk,
  streamFrames,
  streamUsage,
  reasoningLeak,
  errorShapeProbe,
];

export function selectProbes(only?: string[]): Probe[] {
  if (!only || !only.length) return PROBES;
  const wanted = new Set(only);
  const unknown = only.filter((n) => !PROBES.some((p) => p.name === n));
  if (unknown.length) {
    throw new Error(
      `unknown probe(s): ${unknown.join(', ')}\navailable: ${PROBES.map((p) => p.name).join(', ')}`,
    );
  }
  return PROBES.filter((p) => wanted.has(p.name));
}
