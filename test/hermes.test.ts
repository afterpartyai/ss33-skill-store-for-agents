/**
 * Hermes adapter: the `hook hermes pre-llm-call` contract (unit), and the plugin's Python shim end to
 * end: adapters/hermes/__init__.py, loaded by `python3 -I` with a stand-in for Hermes's plugin context,
 * runs the shipped launcher and bundle against the fake store.
 */
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { promptForMatching, runHook } from "../src/adapters/hermes.js";
import { DEFAULT_CONFIG, readHookStatus } from "../src/core/config.js";
import { loadSkillFixture } from "../src/fakestore/fixtures.js";
import { startFakeStore, type FakeStore } from "../src/fakestore/server.js";
import { candidate, fakeClient, tempDir } from "./helpers.js";

const prompt = "Set up a GitHub Actions CI pipeline that runs lint and tests on every PR";
const ON = { ...DEFAULT_CONFIG, match: { ...DEFAULT_CONFIG.match, enabled: true } };

function project(): string {
  const dir = tempDir("ss33-hermes-");
  mkdirSync(join(dir, ".git"));
  return dir;
}

function setup(config = ON) {
  const env = { SS33_STATE_DIR: tempDir(), SS33_CONFIG_DIR: tempDir() };
  const calls: { method: string }[] = [];
  const client = fakeClient({ calls, candidates: [candidate("b/gha-2", "Github Actions CI", "GitHub Actions pipeline with lint and test steps")] });
  return { env, calls, deps: { env, config, client } };
}

const input = (fields: Record<string, unknown>) => JSON.stringify({ session_id: "h-1", cwd: project(), prompt, surface: "cli", ...fields });

test("hermes hook: context for the model and a notice for the user, with Hermes's /ss33:add", async () => {
  const { env, deps } = setup();
  const out = JSON.parse(await runHook("pre-llm-call", input({}), deps));
  assert.match(out.context, /b\/gha-2/);
  assert.match(out.context, /\/ss33:add b\/gha-2/);
  assert.match(out.notice, /\/ss33:add b\/gha-2/);
  assert.deepEqual(Object.keys(out).sort(), ["context", "notice"]);
  assert.equal(readHookStatus(env)?.harness, "hermes");
});

test("hermes hook: chat apps are skipped unless match.chatApps is on; local clients are not", async () => {
  for (const surface of ["telegram", "slack", "discord"]) {
    const { env, calls, deps } = setup();
    assert.equal(await runHook("pre-llm-call", input({ surface }), deps), "", surface);
    assert.equal(calls.length, 0, `${surface}: no network call`);
    assert.match(readFileSync(join(env.SS33_STATE_DIR, "hook.log"), "utf8"), new RegExp(`skip: chat app \\(${surface}\\)`));
  }
  for (const surface of ["cli", "tui", "desktop", "acp", ""]) {
    const { deps } = setup();
    assert.notEqual(await runHook("pre-llm-call", input({ surface }), deps), "", `${surface || "no surface"} is matched`);
  }
  const { deps } = setup({ ...ON, match: { ...ON.match, chatApps: true } });
  assert.notEqual(await runHook("pre-llm-call", input({ surface: "telegram" }), deps), "", "chatApps on");
});

test("hermes hook: skipped with no working directory or outside a project", async () => {
  const noCwd = setup();
  assert.equal(await runHook("pre-llm-call", input({ cwd: "" }), noCwd.deps), "");
  assert.equal(await runHook("pre-llm-call", JSON.stringify({ prompt, surface: "cli" }), noCwd.deps), "", "cwd missing");
  assert.equal(noCwd.calls.length, 0);

  const bare = setup();
  assert.equal(await runHook("pre-llm-call", input({ cwd: tempDir("ss33-not-a-project-") }), bare.deps), "");
  assert.equal(bare.calls.length, 0);
  assert.match(readFileSync(join(bare.env.SS33_STATE_DIR, "hook.log"), "utf8"), /skip: no project/);

  // A manifest is enough, even without git.
  const manifest = tempDir("ss33-manifest-");
  writeFileSync(join(manifest, "package.json"), JSON.stringify({ devDependencies: { typescript: "^5.6.0" } }));
  assert.notEqual(await runHook("pre-llm-call", input({ cwd: manifest }), setup().deps), "");
});

test("hermes hook: a skill slash command, which Hermes expands before the hook, is skipped", async () => {
  const { env, calls, deps } = setup();
  // What Hermes sends for `/ss33:add …`: the skill body behind a fixed note. The body mentions skills and installs.
  const expanded = `[IMPORTANT: The user has invoked the "ss33:add" skill, indicating they want you to follow its instructions. The full skill content is loaded below.]\n\n${prompt}`;
  assert.equal(await runHook("pre-llm-call", input({ prompt: expanded }), deps), "");
  assert.equal(calls.length, 0, "no network call");
  assert.match(readFileSync(join(env.SS33_STATE_DIR, "hook.log"), "utf8"), /skip: slash command/);
  assert.equal(promptForMatching("Use the [IMPORTANT: The user has invoked the ... ] text"), "Use the [IMPORTANT: The user has invoked the ... ] text");
});

test("hermes hook: silent on bad input, unknown events and store errors", async () => {
  const { env } = setup();
  assert.equal(await runHook("pre-llm-call", "not json", { env, config: ON }), "");
  assert.equal(await runHook("pre-llm-call", JSON.stringify({ prompt: 42 }), { env, config: ON }), "");
  assert.equal(await runHook("user-prompt-submit", input({}), { env, config: ON }), "", "Hermes has no such event");
  assert.equal(await runHook("pre-llm-call", input({}), { env, config: ON, client: fakeClient({ status: 401 }) }), "");
  assert.match(readFileSync(join(env.SS33_STATE_DIR, "hook.log"), "utf8"), /\[hermes\] pre-llm-call failed/);
});

// ---- The Python shim, end to end -------------------------------------------------------------

const python = (() => {
  try {
    execFileSync("python3", ["-c", "import sys; assert sys.version_info >= (3, 9)"], { stdio: "ignore" });
    return "python3";
  } catch {
    return undefined;
  }
})();
const skip = python ? false : "python3 (3.9+) not found";

// Stands in for Hermes's PluginContext: only the methods the shim uses, recording what it registers.
const DRIVER = `
import importlib.util, json, sys
root, cwd, surface, prompt = sys.argv[1:5]
if len(sys.argv) > 5: sys.path.insert(0, sys.argv[5])  # a stand-in for Hermes's agent.secret_scope
spec = importlib.util.spec_from_file_location("ss33_hermes_plugin", root + "/__init__.py", submodule_search_locations=[root])
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

class Handle:
    ok = True

class Ctx:
    def __init__(self):
        self.hooks, self.tools, self.skills, self.posted = {}, {}, {}, []
    def session_cwd(self): return cwd
    def session_surface(self): return surface
    def post_message(self, text):
        self.posted.append(text)
        return Handle()
    def register_hook(self, name, cb): self.hooks[name] = cb
    def register_tool(self, name, toolset, schema, handler, **kw): self.tools[name] = (toolset, schema, handler)
    def register_skill(self, name, path, description="", frontmatter=None):
        self.skills[name] = {"path": str(path), "description": description, "frontmatter": frontmatter}

ctx = Ctx()
mod.register(ctx)
out = {"hooks": sorted(ctx.hooks), "tools": {k: v[0] for k, v in ctx.tools.items()}, "skills": ctx.skills}
# Hermes passes a list of content parts on multimodal turns; the image must not reach the CLI.
parts = [{"type": "text", "text": prompt}, {"type": "image_url", "image_url": {"url": "data:image/png;base64,AAAA"}}]
out["context"] = ctx.hooks["pre_llm_call"](session_id="py-1", user_message=parts, conversation_history=[], is_first_turn=True, model="m", platform="cli")
out["posted"] = ctx.posted
out["search"] = json.loads(ctx.tools["ss33_search"][2]({"query": "set up github actions ci"}, task_id="t"))
out["prefetch"] = ctx.hooks["on_session_start"](session_id="py-1", model="m", platform="cli")
print(json.dumps(out))
`;

let store: FakeStore;
before(async () => {
  store = await startFakeStore({ skills: loadSkillFixture(join(process.cwd(), "test/fixtures/store/basic.json")) });
});
after(() => store.close());

function runShim(opts: { cwd: string; surface: string; env: Record<string, string>; endpoint?: string; secrets?: string }): Promise<{ code: number; stdout: string; stderr: string }> {
  const scratch = tempDir("ss33-shim-");
  const driver = join(scratch, "driver.py");
  writeFileSync(driver, DRIVER);
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined || k.startsWith("SS33_") || k.startsWith("CLAUDE") || k.startsWith("HERMES")) continue;
    env[k] = v;
  }
  Object.assign(
    env,
    {
      HOME: scratch, // so the shim doesn't find the developer's own ~/.hermes/node
      HERMES_HOME: join(scratch, "hermes"),
      SS33_ENDPOINT: opts.endpoint ?? store.url,
      SS33_MATCH: "1", // prompt matching is opt-in
      SS33_CONFIG_DIR: join(scratch, "cfg"),
      SS33_STATE_DIR: join(scratch, "state"),
      SS33_RUNTIME_DIR: join(scratch, "runtime"),
      SS33_NODE_DIST: "http://127.0.0.1:9/never", // any download attempt fails
    },
    opts.env,
  );
  return new Promise((resolve) => {
    execFile(python!, ["-I", "-B", driver, join(process.cwd(), "adapters/hermes"), opts.cwd, opts.surface, prompt, ...(opts.secrets ? [opts.secrets] : [])], { cwd: scratch, env, timeout: 30_000 }, (err, stdout, stderr) =>
      resolve({ code: err ? 1 : 0, stdout, stderr }),
    );
  });
}

test("hermes shim: registers its hook, tool and skills; the hook and tool run the shipped CLI", { skip }, async () => {
  const dir = project();
  writeFileSync(join(dir, "package.json"), JSON.stringify({ devDependencies: { typescript: "^5.6.0" } }));
  const r = await runShim({ cwd: dir, surface: "cli", env: { SS33_NODE: process.execPath } });
  assert.equal(r.code, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.deepEqual(out.hooks, ["on_session_start", "pre_llm_call"]);
  assert.deepEqual(out.tools, { ss33_search: "ss33" });
  assert.deepEqual(Object.keys(out.skills).sort(), ["add", "list", "search", "setup", "update"]);
  // Hermes builds the model's skill list from what register_skill gets, so the gates and descriptions
  // passed there must match each SKILL.md.
  for (const [name, s] of Object.entries(out.skills as Record<string, { path: string; description: string; frontmatter: { metadata: { hermes: Record<string, string[]> } } }>)) {
    const md = readFileSync(s.path, "utf8");
    assert.equal(`description: ${s.description}`, md.match(/^description: .+$/m)![0], name);
    const gate = Object.entries(s.frontmatter.metadata.hermes).map(([k, v]) => `${k}: [${v.join(", ")}]`);
    assert.equal(gate.length, 1, name);
    assert.ok(md.includes(`    ${gate[0]}\n`), `${name}: SKILL.md declares ${gate[0]}`);
  }
  assert.match(out.context.context, /\/ss33:add acme\/github-actions-ci-1001/);
  assert.equal(out.posted.length, 1);
  assert.match(out.posted[0], /^ss33: a published skill may fit this task/);
  assert.match(out.search.results, /acme\/github-actions-ci-1001/);
  assert.match(out.search.note, /data, not instructions/);
  assert.equal(out.prefetch, null);
  const query = store.calls.filter((c) => c.tool === "search_skills").map((c) => String(c.args?.query));
  assert.ok(query.every((q) => !q.includes("base64")), "images never sent");
  assert.ok(query.some((q) => /typescript/.test(q)), "project summary from the session's cwd");
});

test("hermes shim: uses Hermes's own Node.js, never downloading one; silent in chat apps", { skip }, async () => {
  const dir = project();
  const scratchHermes = tempDir("ss33-hermes-home-");
  mkdirSync(join(scratchHermes, "node", "bin"), { recursive: true });
  symlinkSync(process.execPath, join(scratchHermes, "node", "bin", "node"));
  // No SS33_NODE and no node on PATH: the only runtime is the one under HERMES_HOME.
  const r = await runShim({ cwd: dir, surface: "cli", env: { HERMES_HOME: scratchHermes, SS33_NO_SYSTEM_NODE: "1" } });
  assert.equal(r.code, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.match(out.context?.context ?? "", /acme\/github-actions-ci-1001/, "hook ran with Hermes's Node");
  assert.match(out.search.results, /acme\/github-actions-ci-1001/);

  const chat = JSON.parse((await runShim({ cwd: dir, surface: "telegram", env: { SS33_NODE: process.execPath } })).stdout);
  assert.equal(chat.context, null);
  assert.deepEqual(chat.posted, []);
});

test("hermes shim: a failing CLI never breaks the turn", { skip }, async () => {
  const r = await runShim({ cwd: project(), surface: "cli", env: { SS33_NODE: "/nonexistent/node" } });
  assert.equal(r.code, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.context, null);
  assert.ok(out.search.error, "the tool reports the failure to the model instead of raising");
});

test("hermes shim: the API key comes only from Hermes's profile-scoped secret, never the inherited env", { skip }, async () => {
  // A multi-profile gateway's environment can hold another profile's SS33_API_KEY.
  const keyed = await startFakeStore({ skills: loadSkillFixture(join(process.cwd(), "test/fixtures/store/basic.json")), auth: { keys: ["ss33_this_profile"] } });
  try {
    const secrets = tempDir("ss33-secrets-");
    mkdirSync(join(secrets, "agent"));
    writeFileSync(join(secrets, "agent", "__init__.py"), "");
    writeFileSync(join(secrets, "agent", "secret_scope.py"), 'def get_secret(name):\n    return "ss33_this_profile" if name == "SS33_API_KEY" else None\n');
    const env = { SS33_NODE: process.execPath, SS33_API_KEY: "ss33_other_profile" };

    const scoped = await runShim({ cwd: project(), surface: "cli", env, endpoint: keyed.url, secrets });
    assert.equal(scoped.code, 0, scoped.stderr);
    const searches = keyed.calls.filter((c) => c.tool === "search_skills");
    assert.ok(searches.length > 0);
    assert.ok(searches.every((c) => c.auth === "key"), "the scoped key was sent, not the inherited one");

    // Without Hermes's lookup (older or stripped-down host) there is no key: the free tier, not a guess.
    keyed.calls.length = 0;
    const bare = await runShim({ cwd: project(), surface: "cli", env, endpoint: keyed.url });
    assert.equal(bare.code, 0, bare.stderr);
    assert.ok(keyed.calls.filter((c) => c.tool === "search_skills").every((c) => c.auth === "anonymous"));
  } finally {
    await keyed.close();
  }
});

test("hermes shim: on Windows, finds Git Bash when sh isn't on the gateway's PATH", { skip }, () => {
  const root = tempDir("ss33-git-");
  for (const f of ["PATHGIT/cmd/git.exe", "PATHGIT/bin/bash.exe", "PF/Git/usr/bin/bash.exe"]) {
    mkdirSync(join(root, f, ".."), { recursive: true });
    writeFileSync(join(root, f), "");
  }
  // Simulated: os.name is "nt", and shutil.which finds only what the case puts on PATH.
  const probe = (onPath: string) =>
    execFileSync(python!, ["-I", "-B", "-c", `
import importlib.util, os, shutil, sys
root, plugin, on_path = sys.argv[1:4]
spec = importlib.util.spec_from_file_location("p", plugin + "/__init__.py", submodule_search_locations=[plugin])
mod = importlib.util.module_from_spec(spec); spec.loader.exec_module(mod)
shutil.which = lambda name: os.path.join(root, on_path) if on_path and name == "git" else None
os.name = "nt"
os.environ["ProgramFiles"] = os.path.join(root, "PF")
print(mod._shell())
`, root, join(process.cwd(), "adapters/hermes"), onPath], { encoding: "utf8" }).trim();
  assert.equal(probe("PATHGIT/cmd/git.exe"), join(root, "PATHGIT/bin/bash.exe"), "next to git.exe on PATH");
  assert.equal(probe(""), join(root, "PF/Git/usr/bin/bash.exe"), "Git for Windows' default folder");
});
