/**
 * npm run eval:matching            replay test/cassettes/live offline and print the report
 * npm run eval:matching -- --record   record cases the cassettes don't cover yet, from the real store
 * npm run eval:matching -- --update-baseline   accept the current numbers as the new baseline
 * Add --json for machine-readable output, --verbose to see every case.
 * --set dev (default) | holdout: which case file. Tune matching on dev only; holdout checks it generalises.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { StoreClient } from "../../src/core/client.js";
import { DEFAULT_ENDPOINT, loadConfig } from "../../src/core/config.js";
import { startFakeStore } from "../../src/fakestore/server.js";
import { loadCases, metrics, runCase, type CaseResult } from "./corpus.js";

const ROOT = process.cwd();
export type CaseSet = "dev" | "holdout";
export const SETS: Record<CaseSet, { cases: string; baseline: string }> = {
  dev: { cases: join(ROOT, "test/matching/cases.jsonl"), baseline: join(ROOT, "test/matching/baseline.json") },
  holdout: { cases: join(ROOT, "test/matching/holdout.jsonl"), baseline: join(ROOT, "test/matching/baseline-holdout.json") },
};
export const CASSETTES = join(ROOT, "test/cassettes/live");
/** Kept for the dev set's existing callers. */
export const BASELINE = SETS.dev.baseline;

export async function evaluate(opts: { record?: boolean; set?: CaseSet } = {}): Promise<{ results: CaseResult[]; misses: number }> {
  const apiKey = loadConfig().apiKey;
  const store = await startFakeStore({
    cassetteDir: CASSETTES,
    ...(opts.record ? { record: { upstream: DEFAULT_ENDPOINT, ...(apiKey ? { apiKey } : {}) } } : {}),
  });
  try {
    const client = new StoreClient({ endpoint: store.url, timeoutMs: 30_000 });
    const results: CaseResult[] = [];
    for (const c of loadCases(SETS[opts.set ?? "dev"].cases)) {
      try {
        results.push(await runCase(c, client));
      } catch (err) {
        results.push({ id: c.id, expect: c.expect, outcome: "none", reason: `store error: ${(err as Error).message}`, verdict: c.expect === "hint" ? "missed-hint" : "correct-none" });
      }
    }
    return { results, misses: store.misses.length };
  } finally {
    await store.close();
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const args = new Set(argv);
  const set: CaseSet = argv.includes("holdout") ? "holdout" : "dev";
  const { results, misses } = await evaluate({ record: args.has("--record"), set });
  const m = metrics(results);
  if (args.has("--json")) return void console.log(JSON.stringify({ metrics: m, results }, null, 2));
  const show = args.has("--verbose") ? results : results.filter((r) => !r.verdict.startsWith("correct"));
  for (const r of show) console.log(`${r.verdict.padEnd(13)} ${r.id.padEnd(34)} ${r.suggested ?? r.reason ?? ""}`);
  console.log(`\n${m.cases} cases · ${m.hints} hints · precision ${m.precision} · recall ${m.recall} · hint rate ${m.hintRate}`);
  console.log(`false hints ${m.falseHints} · wrong hints ${m.wrongHints} · missed hints ${m.missedHints}`);
  if (misses) console.log(`\n⚠ ${misses} store call(s) had no cassette. Run: npm run eval:matching -- --record`);
  console.log(`set: ${set}`);
  let baseline: Record<string, number> = {};
  try {
    baseline = JSON.parse(readFileSync(SETS[set].baseline, "utf8").trim() || "{}");
  } catch {
    // no baseline yet for this set
  }
  if (baseline.precision !== undefined) console.log(`baseline: precision ${baseline.precision} · recall ${baseline.recall} · hint rate ${baseline.hintRate}`);
  if (args.has("--update-baseline")) {
    writeFileSync(SETS[set].baseline, JSON.stringify(m, null, 2) + "\n");
    console.log(`baseline updated: ${SETS[set].baseline}`);
  }
}

if (process.argv[1]?.endsWith("matching/run.js")) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
