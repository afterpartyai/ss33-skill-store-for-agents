/**
 * Regression gate for prompt matching: replays recorded store answers (offline) through the hook's
 * decision path and fails if precision or recall drop below the baseline, or if there are more bad hints.
 * Two sets: dev (tuned on) and holdout (never tuned on; the honest measure of generalisation).
 * After an intended improvement: npm run eval:matching -- [holdout] --update-baseline
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { metrics, type Metrics } from "./matching/corpus.js";
import { evaluate, SETS, type CaseSet } from "./matching/run.js";

for (const set of ["dev", "holdout"] as CaseSet[]) {
  test(`matching eval (${set}): no regression against the baseline`, async () => {
    const { results, misses } = await evaluate({ set });
    assert.equal(misses, 0, `a case has no recorded store answer: run \`npm run eval:matching -- ${set} --record\``);
    const m = metrics(results);
    const base = JSON.parse(readFileSync(SETS[set].baseline, "utf8")) as Metrics;
    const bad = (x: Metrics) => x.falseHints + x.wrongHints;
    const report = `now: precision ${m.precision}, recall ${m.recall}, bad hints ${bad(m)} · baseline: ${base.precision}, ${base.recall}, ${bad(base)}`;
    assert.ok(m.precision >= base.precision, `precision dropped (${report})`);
    assert.ok(m.recall >= base.recall, `recall dropped (${report})`);
    assert.ok(bad(m) <= bad(base), `more bad hints (${report})`);
  });
}
