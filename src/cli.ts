#!/usr/bin/env bun
import { TARGETS, customTarget, missingEnv } from './targets.ts';
import { selectProbes, PROBES } from './probes/index.ts';
import { runTarget } from './run.ts';
import { printReport, markdownMatrix, jsonReport } from './report.ts';
import type { Target, TargetReport } from './types.ts';

const HELP = `wirecheck — how does this "OpenAI-compatible" endpoint actually differ?

usage:
  wirecheck [options]

options:
  -t, --target <names>   comma-separated target names, or "all"   (default: all configured)
  -m, --model <id>       override the target's default model
  -p, --probe <names>    comma-separated probe names              (default: all)
      --url <url>        probe an arbitrary chat/completions URL
      --key-env <VAR>    env var holding the bearer token for --url
      --max-calls <n>    ceiling on model calls per target
      --json             machine-readable output on stdout
      --markdown         emit the markdown matrix on stdout
  -v, --verbose          print the evidence behind every finding
      --list             list targets and probes, then exit
      --dry-run          show what would run and its call cost, then exit
  -h, --help             this

targets:   ${Object.keys(TARGETS).join(', ')}
probes:    ${PROBES.map((p) => p.name).join(', ')}

Nothing is sent anywhere but the endpoint under test. Evidence is redacted
before it is printed or written.`;

interface Args {
  targets?: string[];
  model?: string;
  probes?: string[];
  url?: string;
  keyEnv?: string;
  maxCalls?: number;
  json: boolean;
  markdown: boolean;
  verbose: boolean;
  list: boolean;
  dryRun: boolean;
  help: boolean;
}

function parse(argv: string[]): Args {
  const a: Args = {
    json: false,
    markdown: false,
    verbose: false,
    list: false,
    dryRun: false,
    help: false,
  };
  const list = (v: string | undefined) =>
    (v ?? '').split(',').map((s) => s.trim()).filter(Boolean);

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => argv[++i];
    switch (arg) {
      case '-t': case '--target': a.targets = list(next()); break;
      case '-m': case '--model': a.model = next(); break;
      case '-p': case '--probe': a.probes = list(next()); break;
      case '--url': a.url = next(); break;
      case '--key-env': a.keyEnv = next(); break;
      case '--max-calls': a.maxCalls = Number(next()); break;
      case '--json': a.json = true; break;
      case '--markdown': a.markdown = true; break;
      case '-v': case '--verbose': a.verbose = true; break;
      case '--list': a.list = true; break;
      case '--dry-run': a.dryRun = true; break;
      case '-h': case '--help': a.help = true; break;
      default:
        if (arg?.startsWith('-')) {
          console.error(`unknown option: ${arg}\n`);
          console.error(HELP);
          process.exit(2);
        }
    }
  }
  return a;
}

function resolveTargets(a: Args): Target[] {
  if (a.url) {
    if (!a.model) {
      console.error('--url requires --model (there is no default model for an unknown endpoint)');
      process.exit(2);
    }
    return [customTarget(a.url, a.model, a.keyEnv)];
  }
  const names =
    !a.targets || a.targets.includes('all')
      ? // Default to whatever is actually configured, so a bare `wirecheck` is
        // useful instead of a wall of "missing env".
        Object.values(TARGETS).filter((t) => missingEnv(t).length === 0).map((t) => t.name)
      : a.targets;

  const unknown = names.filter((n) => !TARGETS[n]);
  if (unknown.length) {
    console.error(`unknown target(s): ${unknown.join(', ')}`);
    console.error(`available: ${Object.keys(TARGETS).join(', ')}`);
    process.exit(2);
  }
  if (!names.length) {
    console.error('No target is configured. Set a key (e.g. OPENAI_API_KEY) or run Ollama locally.');
    console.error(`Targets and their required env vars:`);
    for (const t of Object.values(TARGETS)) {
      console.error(`  ${t.name.padEnd(12)} ${t.requires.join(', ') || '(none)'}`);
    }
    process.exit(2);
  }
  return names.map((n) => TARGETS[n]!);
}

async function main() {
  const a = parse(process.argv.slice(2));
  if (a.help) { console.log(HELP); return; }

  if (a.list) {
    console.log('targets:');
    for (const t of Object.values(TARGETS)) {
      const miss = missingEnv(t);
      const state = miss.length ? `needs ${miss.join(', ')}` : 'configured';
      console.log(`  ${t.name.padEnd(12)} ${state.padEnd(28)} ${t.note ?? ''}`);
    }
    console.log('\nprobes:');
    for (const p of PROBES) console.log(`  ${p.name.padEnd(16)} ${p.because}`);
    return;
  }

  let probes;
  try {
    probes = selectProbes(a.probes);
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(2);
  }

  const targets = resolveTargets(a);

  if (a.dryRun) {
    const perTarget = probes.reduce((n, p) => n + p.calls, 0);
    console.log(`${probes.length} probe(s) × ${targets.length} target(s)`);
    console.log(`≈ ${perTarget} model call(s) per target, ${perTarget * targets.length} total`);
    for (const t of targets) console.log(`  ${t.name} → ${a.model || t.defaultModel}`);
    return;
  }

  const quiet = a.json || a.markdown;
  const reports: TargetReport[] = [];
  for (const t of targets) {
    if (!quiet) process.stderr.write(`${t.name}: `);
    const report = await runTarget(t, probes, {
      model: a.model,
      verbose: a.verbose,
      maxCalls: a.maxCalls,
      onProbeDone: quiet ? undefined : () => process.stderr.write('.'),
    });
    if (!quiet) process.stderr.write('\n');
    reports.push(report);
  }

  if (a.json) { console.log(jsonReport(reports)); return; }
  if (a.markdown) { console.log(markdownMatrix(reports)); return; }
  printReport(reports, a.verbose);

  // Exit non-zero only on an inconclusive run. A divergence is information, not
  // a failure — making it fail CI would punish people for adding a provider.
  const noneConclusive = reports.every((r) => !r.reachable);
  process.exit(noneConclusive ? 1 : 0);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.stack : String(e));
  process.exit(1);
});
