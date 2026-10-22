import type { TargetReport, Verdict } from './types.ts';
import { redactDeep } from './http.ts';
import { PROBES } from './probes/index.ts';

const GLYPH: Record<Verdict, string> = {
  matches: '=',
  diverges: '≠',
  unsupported: '✗',
  error: '!',
  skipped: '·',
};

const COLOR: Record<Verdict, string> = {
  matches: '\x1b[32m',
  diverges: '\x1b[33m',
  unsupported: '\x1b[31m',
  error: '\x1b[31m',
  skipped: '\x1b[90m',
};
const RESET = '\x1b[0m';
const DIM = '\x1b[90m';
const BOLD = '\x1b[1m';

const useColor = () => process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (v: Verdict, s: string) => (useColor() ? `${COLOR[v]}${s}${RESET}` : s);
const dim = (s: string) => (useColor() ? `${DIM}${s}${RESET}` : s);
const bold = (s: string) => (useColor() ? `${BOLD}${s}${RESET}` : s);

export function printReport(reports: TargetReport[], verbose: boolean): void {
  for (const r of reports) {
    const header = `${r.target} ${dim(`(${r.model})`)}`;
    console.log(`\n${bold(header)}`);
    if (!r.reachable) {
      const why = r.results[0]?.finding ?? 'unreachable';
      console.log(`  ${dim('unreachable —')} ${why}`);
      continue;
    }
    for (const res of r.results) {
      const g = paint(res.verdict, GLYPH[res.verdict]);
      const ms = res.ms === undefined ? '' : dim(` ${res.ms}ms`);
      console.log(`  ${g} ${res.probe.padEnd(16)} ${res.finding}${ms}`);
      if (verbose && res.evidence !== undefined) {
        const json = JSON.stringify(redactDeep(res.evidence), null, 2)
          .split('\n')
          .map((l) => `      ${dim(l)}`)
          .join('\n');
        console.log(json);
      }
    }
    const d = r.results.filter((x) => x.verdict === 'diverges').length;
    const u = r.results.filter((x) => x.verdict === 'unsupported').length;
    console.log(
      dim(`  — ${d} divergence${d === 1 ? '' : 's'}, ${u} unsupported, ` +
        `${r.results.filter((x) => x.verdict === 'matches').length} matching`),
    );
  }
  console.log(
    `\n${dim(`= matches reference   ≠ diverges   ✗ unsupported   ! error   · skipped`)}`,
  );
}

/** The markdown matrix published in MATRIX.md. */
export function markdownMatrix(reports: TargetReport[]): string {
  const probeNames = PROBES.map((p) => p.name);
  const lines: string[] = [];

  lines.push('| probe | ' + reports.map((r) => `\`${r.target}\``).join(' | ') + ' |');
  lines.push('|---|' + reports.map(() => '---').join('|') + '|');

  for (const name of probeNames) {
    const cells = reports.map((r) => {
      const res = r.results.find((x) => x.probe === name);
      if (!res) return '–';
      return GLYPH[res.verdict];
    });
    lines.push(`| \`${name}\` | ${cells.join(' | ')} |`);
  }

  lines.push('');
  lines.push('`=` matches reference · `≠` diverges · `✗` unsupported · `!` error · `·` skipped');
  lines.push('');
  lines.push('### Findings');
  lines.push('');

  for (const r of reports) {
    lines.push(`#### \`${r.target}\` — ${r.model}`);
    lines.push('');
    if (!r.reachable) {
      lines.push(`_Unreachable: ${r.results[0]?.finding ?? 'unknown'}_`);
      lines.push('');
      continue;
    }
    for (const res of r.results) {
      if (res.verdict === 'matches' || res.verdict === 'skipped') continue;
      lines.push(`- **\`${res.probe}\`** (${res.verdict}) — ${res.finding}`);
    }
    const interesting = r.results.some(
      (x) => x.verdict !== 'matches' && x.verdict !== 'skipped',
    );
    if (!interesting) lines.push('- No divergences found.');
    lines.push('');
  }

  return lines.join('\n');
}

export function jsonReport(reports: TargetReport[]): string {
  return JSON.stringify(redactDeep({ generatedAt: new Date().toISOString(), reports }), null, 2);
}
