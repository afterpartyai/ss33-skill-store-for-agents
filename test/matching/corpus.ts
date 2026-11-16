/**
 * Prompt-matching eval: labelled prompts → the hook's own decision path → metrics.
 *
 * Each case runs exactly what onPromptSubmitted does (pre-filter, search with limit 3, decide), against
 * a store, normally the fake store replaying cassettes recorded from the real one.
 */
import { readFileSync } from "node:fs";
import type { StoreClient } from "../../src/core/client.js";
import { DEFAULT_CONFIG } from "../../src/core/config.js";
import { buildQuery, decide, shouldSearch, type MatchOutcome } from "../../src/core/match.js";

export interface MatchCase {
  id: string;
  prompt: string;
  /** Project summary, in `ss33 fingerprint` format. */
  project?: string;
  /**
   * none: any hint is wrong. hint: a hint is wanted and must be one of `acceptable`.
   * optional: no hint is fine, but a hint must be one of `acceptable`.
   */
  expect: "none" | "hint" | "optional";
  /** Refs (or /regex/) that count as a good hint. */
  acceptable?: string[];
  /** Where the case came from: "real:<date>" for prompts from real sessions, "written" for constructed ones. */
  source: string;
  note?: string;
}

export type Verdict = "correct-none" | "correct-hint" | "false-hint" | "wrong-hint" | "missed-hint";

export interface CaseResult {
  id: string;
  expect: MatchCase["expect"];
  outcome: MatchOutcome["kind"];
  suggested?: string;
  reason?: string;
  verdict: Verdict;
}

export interface Metrics {
  cases: number;
  hints: number;
  /** Hints given that were acceptable. The headline number: a wrong hint costs the user attention. */
  precision: number;
  /** Of the cases that want a hint, how many got an acceptable one. */
  recall: number;
  hintRate: number;
  falseHints: number;
  wrongHints: number;
  missedHints: number;
}

export function loadCases(path: string): MatchCase[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l.trim() && !l.trimStart().startsWith("//"))
    .map((l) => JSON.parse(l) as MatchCase);
}

function acceptable(c: MatchCase, ref: string): boolean {
  return (c.acceptable ?? []).some((a) => (a.startsWith("/") && a.endsWith("/") ? new RegExp(a.slice(1, -1)).test(ref) : a === ref));
}

export async function runCase(c: MatchCase, client: StoreClient): Promise<CaseResult> {
  const pre = shouldSearch(c.prompt);
  let outcome: MatchOutcome;
  if (!pre.ok) outcome = { kind: "skip", reason: pre.reason };
  else {
    const result = await client.search(buildQuery(c.prompt, c.project), { limit: 3 });
    outcome = decide(
      { prompt: c.prompt, ...(c.project ? { projectSummary: c.project } : {}), installed: [], session: { suggested: [], hints: 0 }, config: { ...DEFAULT_CONFIG.match, enabled: true } },
      result,
    );
  }
  const suggested = outcome.kind === "suggest" ? outcome.candidate.ref : undefined;
  let verdict: Verdict;
  if (!suggested) verdict = c.expect === "hint" ? "missed-hint" : "correct-none";
  else if (c.expect === "none") verdict = "false-hint";
  else verdict = acceptable(c, suggested) ? "correct-hint" : "wrong-hint";
  return {
    id: c.id,
    expect: c.expect,
    outcome: outcome.kind,
    ...(suggested ? { suggested } : {}),
    ...(outcome.kind !== "suggest" ? { reason: outcome.reason } : {}),
    verdict,
  };
}

export function metrics(results: CaseResult[]): Metrics {
  const count = (v: Verdict) => results.filter((r) => r.verdict === v).length;
  const hints = results.filter((r) => r.suggested).length;
  const wanted = results.filter((r) => r.expect === "hint").length;
  const good = count("correct-hint");
  const goodWanted = results.filter((r) => r.expect === "hint" && r.verdict === "correct-hint").length;
  const round = (n: number) => Math.round(n * 1000) / 1000;
  return {
    cases: results.length,
    hints,
    precision: hints ? round(good / hints) : 1,
    recall: wanted ? round(goodWanted / wanted) : 1,
    hintRate: results.length ? round(hints / results.length) : 0,
    falseHints: count("false-hint"),
    wrongHints: count("wrong-hint"),
    missedHints: count("missed-hint"),
  };
}
