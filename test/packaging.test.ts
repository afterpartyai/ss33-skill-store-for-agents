/**
 * The two plugin roots must ship the same CLI, agree on the version, and each speak its own harness's dialect.
 * Runs from the repo root (npm test), against the source tree rather than build/.
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { VERSION } from "../src/core/version.js";

const root = process.cwd();
const read = (p: string) => readFileSync(join(root, p), "utf8");
const json = (p: string) => JSON.parse(read(p));

test("packaging: the Codex plugin carries the same bundle and launcher as the Claude Code plugin", () => {
  assert.equal(read("adapters/codex/lib/ss33.cjs"), read("adapters/claude-code/lib/ss33.cjs"), "run `npm run build` (it copies the bundle)");
  assert.equal(read("adapters/codex/scripts/ss33"), read("adapters/claude-code/scripts/ss33"), "run `npm run build` (it copies the launcher)");
});

test("packaging: one version everywhere", () => {
  assert.equal(json("package.json").version, VERSION);
  assert.equal(json("adapters/claude-code/.claude-plugin/plugin.json").version, VERSION);
  assert.equal(json("adapters/codex/.codex-plugin/plugin.json").version, VERSION);
});

test("packaging: marketplaces point each harness at its own plugin root", () => {
  assert.equal(json(".claude-plugin/marketplace.json").plugins[0].source, "./adapters/claude-code");
  // Codex prefers .agents/plugins/marketplace.json over .claude-plugin/marketplace.json in the same repo.
  assert.deepEqual(json(".agents/plugins/marketplace.json").plugins[0].source, { source: "local", path: "./adapters/codex" });
});

test("packaging: Codex hooks and skills use Codex's conventions", () => {
  const hooks = read("adapters/codex/hooks/hooks.json");
  assert.match(hooks, /hook codex user-prompt-submit/);
  assert.doesNotMatch(hooks, /claude-code/);
  const skills = readdirSync(join(root, "adapters/codex/skills"));
  assert.deepEqual(skills.sort(), readdirSync(join(root, "adapters/claude-code/skills")).sort(), "same skills in both plugins");
  for (const s of skills) {
    const md = read(`adapters/codex/skills/${s}/SKILL.md`);
    assert.match(md, new RegExp(`^---\\nname: ${s}\\n`), `${s}: frontmatter name`);
    // Codex substitutes nothing in SKILL.md (no ${CLAUDE_PLUGIN_ROOT}, no $ARGUMENTS) and ignores Claude-only frontmatter.
    assert.doesNotMatch(md, /CLAUDE_PLUGIN_ROOT|\$ARGUMENTS|allowed-tools|disable-model-invocation|\/ss33:|\.claude\/skills/, s);
    if (s === "add") assert.match(md, /--target agents/);
    // User-only skills, like disable-model-invocation in Claude Code.
    if (s !== "search") assert.match(read(`adapters/codex/skills/${s}/agents/openai.yaml`), /allow_implicit_invocation: false/, s);
  }
});
