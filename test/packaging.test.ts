/**
 * The three plugin roots must ship the same CLI, agree on the version, and each speak its own harness's dialect.
 * Runs from the repo root (npm test), against the source tree rather than build/.
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
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

test("packaging: the Hermes plugin carries the same bundle and launcher as the Claude Code plugin", () => {
  assert.equal(read("adapters/hermes/lib/ss33.cjs"), read("adapters/claude-code/lib/ss33.cjs"), "run `npm run build` (it copies the bundle)");
  assert.equal(read("adapters/hermes/scripts/ss33"), read("adapters/claude-code/scripts/ss33"), "run `npm run build` (it copies the launcher)");
});

test("packaging: one version everywhere", () => {
  assert.equal(json("package.json").version, VERSION);
  assert.equal(json("adapters/claude-code/.claude-plugin/plugin.json").version, VERSION);
  assert.equal(json("adapters/codex/.codex-plugin/plugin.json").version, VERSION);
  assert.match(read("adapters/hermes/plugin.yaml"), new RegExp(`^version: ${VERSION.replace(/\./g, "\\.")}$`, "m"));
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

/** Every file under a directory, relative to it. */
function files(dir: string, prefix = ""): string[] {
  return readdirSync(join(root, dir)).flatMap((f) =>
    statSync(join(root, dir, f)).isDirectory() ? files(join(dir, f), `${prefix}${f}/`) : [`${prefix}${f}`],
  );
}

test("packaging: Python stays in the Hermes plugin, which needs no dependencies", () => {
  for (const r of ["adapters/claude-code", "adapters/codex"]) {
    assert.deepEqual(files(r).filter((f) => f.endsWith(".py") || f.endsWith(".yaml") && !f.endsWith("openai.yaml")), [], `${r}: nothing Hermes-specific`);
  }
  assert.deepEqual(files("adapters/hermes").filter((f) => f.endsWith(".py")), ["__init__.py"]);
  const manifest = read("adapters/hermes/plugin.yaml").replace(/^\s*#.*\n/gm, "");
  assert.match(manifest, /^name: ss33$/m);
  assert.doesNotMatch(manifest, /python_dependencies|pip_dependencies|requires_env/, "no dependency install, and no required key (the free tier works)");
  assert.ok(!files("adapters/hermes").includes("pyproject.toml"), "a pyproject.toml would make Hermes install dependencies");
  // Standard library only: these are every module the shim imports at load time.
  const shim = read("adapters/hermes/__init__.py");
  const imports = [...shim.matchAll(/^(?:from (\S+) import|import (\S+))/gm)].map((m) => m[1] ?? m[2]);
  assert.deepEqual(imports.sort(), ["__future__", "json", "logging", "os", "pathlib", "subprocess"]);
  for (const tool of manifest.match(/^provides_tools:\n((?:  - .+\n)+)/m)![1]!.match(/[a-z0-9_]+$/gm)!) assert.match(shim, new RegExp(`name="${tool}"`));
});

test("packaging: Hermes skills use Hermes's conventions", () => {
  const skills = readdirSync(join(root, "adapters/hermes/skills"));
  assert.deepEqual(skills.sort(), readdirSync(join(root, "adapters/claude-code/skills")).sort(), "same skills in every plugin");
  for (const s of skills) {
    const md = read(`adapters/hermes/skills/${s}/SKILL.md`);
    assert.match(md, new RegExp(`^---\\nname: ${s}\\n`), `${s}: frontmatter name`);
    // Hermes substitutes only \${HERMES_SKILL_DIR} and \${HERMES_SESSION_ID}, and ignores Claude-only frontmatter.
    assert.doesNotMatch(md, /CLAUDE_PLUGIN_ROOT|\$ARGUMENTS|allowed-tools|disable-model-invocation|\$ss33:|\.claude\/skills/, s);
    if (s !== "setup") assert.match(md, /\$\{HERMES_SKILL_DIR\}\/\.\.\/\.\.\/scripts\/ss33/, s);
    if (s === "add") assert.match(md, /--target agents/);
    if (s === "add") assert.match(md, /hermes skills trust/);
    // Hermes has no disable-model-invocation: user-only skills hide from the model's skill list while
    // the plugin's toolset is on, and search defers to the ss33_search tool.
    if (s === "search") assert.match(md, /fallback_for_tools: \[ss33_search\]/);
    else assert.match(md, /fallback_for_toolsets: \[ss33\]/, s);
  }
});
