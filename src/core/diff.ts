/** Small LCS line diff for reviewing skill updates. Not a general-purpose diff: output is capped. */

const MAX_LINES = 1500;
const MAX_OUTPUT = 120;

export function lineDiff(before: string, after: string): string {
  const a = before.split("\n");
  const b = after.split("\n");
  if (a.length > MAX_LINES || b.length > MAX_LINES) {
    return `(content changed: ${a.length} → ${b.length} lines; too large to diff here)`;
  }
  // LCS table, then walk it to emit kept/removed/added lines.
  const dp: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }
  const out: string[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      i++;
      j++;
    } else if (i < a.length && (j >= b.length || dp[i + 1]![j]! >= dp[i]![j + 1]!)) {
      // On ties, removals print before additions, like unified diffs.
      out.push(`- ${a[i++]}`);
    } else {
      out.push(`+ ${b[j++]}`);
    }
  }
  if (!out.length) return "(no textual changes)";
  return out.length > MAX_OUTPUT ? [...out.slice(0, MAX_OUTPUT), `… ${out.length - MAX_OUTPUT} more changed lines`].join("\n") : out.join("\n");
}
