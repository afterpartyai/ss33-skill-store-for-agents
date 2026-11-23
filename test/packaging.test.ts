/**
 * The plugin roots must ship the same CLI, agree on the version, and each speak its own harness's dialect.
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

test("packaging: the Cursor plugin carries the same bundle and launcher as the Claude Code plugin", () => {
  assert.equal(read("adapters/cursor/lib/ss33.cjs"), read("adapters/claude-code/lib/ss33.cjs"), "run `npm run build` (it copies the bundle)");
  assert.equal(read("adapters/cursor/scripts/ss33"), read("adapters/claude-code/scripts/ss33"), "run `npm run build` (it copies the launcher)");
});

test("packaging: the Copilot plugin carries the same bundle and launcher as the Claude Code plugin", () => {
  assert.equal(read("adapters/copilot/lib/ss33.cjs"), read("adapters/claude-code/lib/ss33.cjs"), "run `npm run build` (it copies the bundle)");
  assert.equal(read("adapters/copilot/scripts/ss33"), read("adapters/claude-code/scripts/ss33"), "run `npm run build` (it copies the launcher)");
});

test("packaging: one version everywhere", () => {
  assert.equal(json("package.json").version, VERSION);
  assert.equal(json("adapters/claude-code/.claude-plugin/plugin.json").version, VERSION);
  assert.equal(json("adapters/codex/.codex-plugin/plugin.json").version, VERSION);
  assert.match(read("adapters/hermes/plugin.yaml"), new RegExp(`^version: ${VERSION.replace(/\./g, "\\.")}$`, "m"));
  assert.equal(json("adapters/cursor/.cursor-plugin/plugin.json").version, VERSION);
  assert.equal(json("adapters/copilot/plugin.json").version, VERSION);
});

test("packaging: marketplaces point each harness at its own plugin root", () => {
  assert.equal(json(".claude-plugin/marketplace.json").plugins[0].source, "./adapters/claude-code");
  // Codex prefers .agents/plugins/marketplace.json over .claude-plugin/marketplace.json in the same repo.
  assert.deepEqual(json(".agents/plugins/marketplace.json").plugins[0].source, { source: "local", path: "./adapters/codex" });
  const cursor = json(".cursor-plugin/marketplace.json").plugins[0];
  assert.equal(cursor.source, "./adapters/cursor");
  assert.equal(cursor.name, json("adapters/cursor/.cursor-plugin/plugin.json").name, "Cursor requires the marketplace name to match plugin.json");
  // Copilot looks for .github/plugin/marketplace.json before .claude-plugin/marketplace.json.
  const copilot = json(".github/plugin/marketplace.json").plugins[0];
  assert.equal(copilot.source, "./adapters/copilot");
  assert.equal(copilot.name, json("adapters/copilot/plugin.json").name);
});

test("packaging: Copilot hooks and skills use Copilot's conventions", () => {
  // Copilot's own format: camelCase events, bash/powershell commands. Claude Code's hookSpecificOutput would be ignored,
  // so the prompt hook routes to the copilot adapter, which answers with a top-level additionalContext.
  const hooks = json("adapters/copilot/hooks/hooks.json");
  assert.equal(hooks.version, 1);
  assert.deepEqual(Object.keys(hooks.hooks).sort(), ["sessionStart", "userPromptSubmitted"]);
  assert.match(hooks.hooks.userPromptSubmitted[0].bash, /^sh "\$PLUGIN_ROOT\/scripts\/ss33" hook copilot user-prompt-submitted$/);
  // Windows: Git for Windows often leaves sh off PATH, so the PowerShell commands look for its bin\sh.exe, and do nothing without it.
  for (const [event, args] of [["userPromptSubmitted", "hook copilot user-prompt-submitted"], ["sessionStart", "__prefetch-runtime"]] as const) {
    const ps: string = hooks.hooks[event][0].powershell;
    assert.match(ps, /^\$s = \(Get-Command sh /, event);
    assert.ok(ps.includes("Join-Path $_ 'bin\\sh.exe'"), event);
    assert.ok(ps.endsWith(`if ($s) { ${event === "userPromptSubmitted" ? "$input | " : ""}& $s "$env:PLUGIN_ROOT/scripts/ss33" ${args} }`), event);
  }
  assert.match(hooks.hooks.sessionStart[0].bash, /__prefetch-runtime$/);
  const skills = readdirSync(join(root, "adapters/copilot/skills"));
  assert.deepEqual(skills.sort(), readdirSync(join(root, "adapters/claude-code/skills")).sort(), "same skills in every plugin (Copilot namespaces them: /ss33:search)");
  for (const s of skills) {
    const md = read(`adapters/copilot/skills/${s}/SKILL.md`);
    assert.match(md, new RegExp(`^---\\nname: ${s}\\n`), `${s}: frontmatter name`);
    // Copilot substitutes $ARGUMENTS but not \${CLAUDE_PLUGIN_ROOT}, so the skills locate the launcher from their own path.
    assert.doesNotMatch(md, /CLAUDE_PLUGIN_ROOT|allowed-tools|\$ss33:|\.claude\/skills|Codex|Cursor|escalat/, s);
    assert.match(md, new RegExp(`<plugin root>/skills/${s}/SKILL\\.md`), `${s}: locates the plugin root`);
    assert.match(md, /C:\\Program Files\\Git\\bin\\sh\.exe/, `${s}: finds sh on Windows`);
    if (s === "add") assert.match(md, /--target agents/);
    if (s === "search") assert.doesNotMatch(md, /disable-model-invocation/);
    else assert.match(md, /^disable-model-invocation: true$/m, `${s}: user-only`);
  }
});

test("packaging: Cursor manifest, hooks and skills use Cursor's conventions", () => {
  // Cursor's plugin schema sets additionalProperties: false, so an unknown key fails validation.
  const allowed = ["name", "displayName", "description", "version", "minClientVersions", "author", "publisher", "homepage", "repository", "license", "logo",
    "keywords", "category", "tags", "commands", "agents", "skills", "rules", "hooks", "variables", "mcpServers"];
  const manifest = json("adapters/cursor/.cursor-plugin/plugin.json");
  for (const k of Object.keys(manifest)) assert.ok(allowed.includes(k), `unknown plugin.json key ${k}`);
  assert.ok(statSync(join(root, "adapters/cursor", manifest.logo)).isFile());
  // Cursor drops the whole hooks file on an unknown event name (seen with UserPromptSubmit, CLI 2026.11.22), and
  // beforeSubmitPrompt can't add context, so the plugin only uses sessionStart.
  const hooks = json("adapters/cursor/hooks/hooks.json");
  assert.equal(hooks.version, 1);
  assert.deepEqual(Object.keys(hooks.hooks), ["sessionStart"]);
  assert.match(hooks.hooks.sessionStart[0].command, /^sh "\$\{CURSOR_PLUGIN_ROOT\}\/scripts\/ss33" __prefetch-runtime$/);
  // Cursor doesn't namespace plugin skills, so each one carries the ss33- prefix (/ss33-search, not /search).
  const skills = readdirSync(join(root, "adapters/cursor/skills"));
  assert.deepEqual(skills.sort(), readdirSync(join(root, "adapters/claude-code/skills")).map((s) => `ss33-${s}`).sort(), "same skills in every plugin");
  for (const s of skills) {
    const md = read(`adapters/cursor/skills/${s}/SKILL.md`);
    assert.match(md, new RegExp(`^---\\nname: ${s}\\n`), `${s}: frontmatter name`);
    assert.doesNotMatch(md, /CLAUDE_PLUGIN_ROOT|\$ARGUMENTS|allowed-tools|\/ss33:|\$ss33:|\.claude\/skills|Codex|escalat/, s);
    assert.match(md, new RegExp(`<plugin root>/skills/${s}/SKILL\\.md`), `${s}: locates the plugin root`);
    assert.match(md, /C:\\Program Files\\Git\\bin\\sh\.exe/, `${s}: finds sh on Windows`);
    if (s === "ss33-add") assert.match(md, /--target agents/);
    if (s === "ss33-search") assert.doesNotMatch(md, /disable-model-invocation/);
    else assert.match(md, /^disable-model-invocation: true$/m, `${s}: user-only`);
  }
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
  for (const r of ["adapters/claude-code", "adapters/codex", "adapters/cursor", "adapters/copilot"]) {
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
  assert.deepEqual(imports.sort(), ["__future__", "json", "logging", "os", "pathlib", "shutil", "subprocess"]);
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
