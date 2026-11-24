/**
 * The plugin roots must ship the same CLI, agree on the version, and each speak its own harness's dialect.
 * Runs from the repo root (npm test), against the source tree rather than build/.
 */
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { DEFAULT_ENDPOINT } from "../src/core/config.js";
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

test("packaging: the DSH plugin carries the same bundle and launcher as the Claude Code plugin", () => {
  assert.equal(read("adapters/dsh/lib/ss33.cjs"), read("adapters/claude-code/lib/ss33.cjs"), "run `npm run build` (it copies the bundle)");
  assert.equal(read("adapters/dsh/scripts/ss33"), read("adapters/claude-code/scripts/ss33"), "run `npm run build` (it copies the launcher)");
});

test("packaging: one version everywhere", () => {
  assert.equal(json("package.json").version, VERSION);
  assert.equal(json("adapters/claude-code/.claude-plugin/plugin.json").version, VERSION);
  assert.equal(json("adapters/codex/.codex-plugin/plugin.json").version, VERSION);
  assert.match(read("adapters/hermes/plugin.yaml"), new RegExp(`^version: ${VERSION.replace(/\./g, "\\.")}$`, "m"));
  assert.equal(json("adapters/cursor/.cursor-plugin/plugin.json").version, VERSION);
  assert.equal(json("adapters/copilot/plugin.json").version, VERSION);
  assert.equal(json("adapters/dsh/package.json").version, VERSION);
});

test("packaging: the DSH plugin is a bundle package whose skills use DSH's conventions", () => {
  const pkg = json("adapters/dsh/package.json");
  assert.equal(pkg.dsh.bundle.patch, "./cordis.patch.yml");
  // The patch row's `name` is the package DSH imports.
  assert.match(read("adapters/dsh/cordis.patch.yml"), new RegExp(`^      name: ${pkg.name}$`, "m"));
  for (const f of files("adapters/dsh").filter((f) => f !== "package.json")) assert.ok(pkg.files.some((p: string) => f === p || f.startsWith(`${p}/`)), `${f} is published`);
  assert.ok(!pkg.dependencies && !pkg.peerDependencies, "nothing to install: a profile can't resolve DSH's own packages");
  assert.doesNotMatch(read("adapters/dsh/index.js"), /from ['"](?!node:)/, "only node: imports");
  // DSH doesn't namespace plugin skills, so they carry the ss33- prefix, like Cursor's.
  const skills = readdirSync(join(root, "adapters/dsh/skills"));
  assert.deepEqual(skills.sort(), readdirSync(join(root, "adapters/claude-code/skills")).map((s) => `ss33-${s}`).sort(), "same skills in every plugin");
  for (const s of skills) {
    const md = read(`adapters/dsh/skills/${s}/SKILL.md`);
    assert.match(md, new RegExp(`^---\\nname: ${s}\\n`), `${s}: frontmatter name`);
    assert.doesNotMatch(md, /CLAUDE_PLUGIN_ROOT|\$ARGUMENTS|allowed-tools|\/ss33:|\$ss33:|\.claude\/skills|Cursor|Codex/, s);
    assert.match(md, /\$DSH_SS33_PLUGIN_ROOT\/scripts\/ss33/, `${s}: locates the launcher`);
    assert.match(md, new RegExp(`<plugin root>/skills/${s}/`), `${s}: fallback when the variable is missing`);
    if (s === "ss33-add") assert.match(md, /--target agents/);
    if (s === "ss33-search") assert.doesNotMatch(md, /disable-model-invocation/);
    else assert.match(md, /^disable-model-invocation: true$/m, `${s}: user-only`);
  }
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

test("packaging: Copilot manifest is Agent Plugins v1.0.0", () => {
  // awesome-copilot's intake rejects any other top-level key. Copilot then finds skills/ at the plugin root and the hooks
  // only under com.github.copilot/ (CLI 1.0.114 changelog), so nothing points at them from the manifest.
  const manifest = json("adapters/copilot/plugin.json");
  assert.equal(manifest.$schema, "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json");
  const allowed = ["$schema", "name", "version", "description", "author", "homepage", "repository", "license", "keywords", "extensions"];
  for (const k of Object.keys(manifest)) assert.ok(allowed.includes(k), `not an Agent Plugins key: ${k}`);
  for (const k of Object.keys(manifest.author)) assert.ok(["name", "email", "url"].includes(k), `author.${k}`);
  assert.match(manifest.name, /^(?!.*(?:--|\.\.))[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/);
  assert.ok(!existsSync(join(root, "adapters/copilot/hooks")), "hooks at the root are ignored for Agent Plugins manifests");
});

test("packaging: Copilot hooks and skills use Copilot's conventions", () => {
  // Copilot's own format: camelCase events, bash/powershell commands. Claude Code's hookSpecificOutput would be ignored,
  // so the prompt hook routes to the copilot adapter, which answers with a top-level additionalContext.
  const hooks = json("adapters/copilot/com.github.copilot/hooks/hooks.json");
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
  for (const r of ["adapters/claude-code", "adapters/codex", "adapters/cursor", "adapters/copilot", "adapters/dsh"]) {
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

test("packaging: the Claude Code plugin declares exactly the hosts ss33 connects to", () => {
  // The store, and the launcher's one-time Node.js download.
  const dist = read("adapters/claude-code/scripts/ss33").match(/^NODE_DIST=\$\{SS33_NODE_DIST:-([^}]+)\}$/m)?.[1];
  assert.ok(dist, "the launcher's NODE_DIST default");
  const expected = [new URL(DEFAULT_ENDPOINT).host, new URL(dist).host].sort();
  assert.deepEqual([...json("adapters/claude-code/.claude-plugin/plugin.json").network.hosts].sort(), expected);
});
