/**
 * Edge cases of the core modules that the feature tests don't reach: every fingerprint ecosystem, the
 * MCP client's session and error handling, config and state locations, and hooks that must never throw.
 */
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runHook as hermesHook } from "../src/adapters/hermes.js";
import { describeNetworkError, parseSse, StoreClient, StoreError, type StoreErrorKind } from "../src/core/client.js";
import { configDir, loadConfig, readHookStatus, setConfigValue, stateDir } from "../src/core/config.js";
import { onSessionStarted } from "../src/core/events.js";
import { install, installedSkills, update } from "../src/core/install.js";
import { fingerprint, summarize } from "../src/core/fingerprint.js";
import { debugLog, loadSession, saveSession } from "../src/core/state.js";
import { fakeClient, SKILL_MD, tempDir } from "./helpers.js";

function project(files: Record<string, string>): string {
  const dir = tempDir();
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
  return dir;
}

test("fingerprint: Go, Rust, Ruby/Rails, Java, Gradle, PHP, Docker and GitLab CI", () => {
  const fp = fingerprint(
    project({
      "go.mod": "module example.com/x\n\ngo 1.23.1\n",
      "Cargo.toml": '[package]\nname = "x"\nedition = "2021"\n',
      Gemfile: "source 'https://rubygems.org'\ngem 'rails', '~> 7.1'\n",
      "pom.xml": "<project/>",
      "build.gradle.kts": "",
      "composer.json": "{}",
      Dockerfile: "FROM node:22",
      ".gitlab-ci.yml": "test: {}",
    }),
  );
  assert.deepEqual(fp.languages, ["go", "rust", "ruby", "java", "jvm", "php"]);
  assert.deepEqual(fp.packageManagers, ["maven", "gradle", "composer"]);
  assert.deepEqual(fp.tools, { go: "1.23.1", "rust-edition": "2021", rails: "~> 7.1", docker: "Dockerfile" });
  assert.deepEqual(fp.ci, ["gitlab-ci"]);

  assert.equal(fingerprint(project({ Gemfile: 'gem "rails"\n' })).tools.rails, "*", "an unpinned gem");
  assert.deepEqual(fingerprint(project({ "go.mod": "module x\n" })).tools, {}, "no go directive");
});

test("fingerprint: JS package managers from lockfile names, Deno, engines, and a malformed package.json", () => {
  const pms = (files: Record<string, string>) => fingerprint(project(files)).packageManagers;
  assert.deepEqual(pms({ "package.json": "{}", "package-lock.json": "" }), ["npm"]);
  assert.deepEqual(pms({ "package.json": "{}", "yarn.lock": "" }), ["yarn"]);
  assert.deepEqual(pms({ "package.json": "{}", "bun.lock": "" }), ["bun"]);
  assert.deepEqual(pms({ "deno.jsonc": "{}" }), ["deno"]);
  assert.equal(fingerprint(project({ "package.json": JSON.stringify({ engines: { node: ">=22" } }) })).tools.node, ">=22");

  const broken = fingerprint(project({ "package.json": "{ not json", "tsconfig.json": "{}" }));
  assert.ok(broken.languages.includes("javascript"), "a malformed package.json still records the language");
});

test("fingerprint: Python package managers (uv, pip) and PEP 508 extras", () => {
  const uv = fingerprint(project({ "pyproject.toml": 'dependencies = ["pydantic[email]~=2.0", "pytest"]\n', "uv.lock": "" }));
  assert.deepEqual(uv.packageManagers, ["uv"]);
  assert.equal(uv.tools.pydantic, "~=2.0");
  assert.equal(uv.tools.pytest, "*");
  const pip = fingerprint(project({ "requirements.txt": "django>=5\nscikit_learn\n" }));
  assert.deepEqual(pip.packageManagers, ["pip"]);
  assert.equal(pip.tools.django, ">=5");
  assert.equal(pip.tools["scikit-learn"], "*", "underscore and dash spellings are the same package");
  assert.deepEqual(fingerprint(project({ "setup.py": "" })).languages, ["python"]);
});

test("fingerprint: the summary is capped, and an unreadable workflows folder is ignored", () => {
  const long = summarize({ languages: Array.from({ length: 80 }, (_, i) => `lang${i}`), packageManagers: [], tools: {}, services: [], ci: [] });
  assert.ok(long.length <= 320);
  assert.ok(long.endsWith("…"));
  // A file where the workflows folder should be.
  assert.deepEqual(fingerprint(project({ ".github/workflows": "not a folder" })).ci, []);
});

/** A fetch stand-in that answers each request with the next scripted response, and records the headers it got. */
function scripted(responses: (Response | Error | ((body: Record<string, unknown>) => Response))[]) {
  const seen: { body: Record<string, unknown>; headers: Record<string, string> }[] = [];
  const fetchImpl = (async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    seen.push({ body, headers: init?.headers as Record<string, string> });
    const next = responses.shift();
    if (!next) throw new Error("no more scripted responses");
    if (next instanceof Error) throw next;
    return typeof next === "function" ? next(body) : next;
  }) as typeof fetch;
  return { seen, client: new StoreClient({ endpoint: "https://store.test/mcp", fetchImpl }) };
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const toolResult = (data: unknown, extra: Record<string, unknown> = {}) => (req: Record<string, unknown>) =>
  json({ jsonrpc: "2.0", id: req.id, result: { content: [{ type: "text", text: JSON.stringify(data) }], structuredContent: data, ...extra } });

async function rejectsKind(p: Promise<unknown>, kind: StoreErrorKind, message?: RegExp): Promise<void> {
  await assert.rejects(p, (err: unknown) => err instanceof StoreError && err.kind === kind && (!message || message.test(err.message)));
}

test("client: a store that wants a session gets one initialize, then the call is retried with the session id", async () => {
  const { seen, client } = scripted([
    json({ jsonrpc: "2.0", id: 1, error: { code: -32000, message: "Bad Request: no valid session ID" } }, 400),
    (req) => json({ jsonrpc: "2.0", id: req.id, result: { protocolVersion: "2025-06-18" } }, 200, { "mcp-session-id": "sess-1" }),
    () => new Response("", { status: 202 }),
    toolResult({ candidates: [], found: false }),
  ]);
  const res = await client.search("anything");
  assert.equal(res.found, false);
  assert.deepEqual(seen.map((s) => s.body.method), ["tools/call", "initialize", "notifications/initialized", "tools/call"]);
  assert.equal(seen[3]!.headers["Mcp-Session-Id"], "sess-1");
  assert.equal(seen[0]!.headers["Mcp-Session-Id"], undefined);
});

test("client: initialize failures, 403, HTTP errors, JSON-RPC errors and empty results are protocol or auth errors", async () => {
  await rejectsKind(scripted([json({}, 404), json({}, 500)]).client.search("x"), "protocol", /MCP initialize failed \(HTTP 500\)/);
  await rejectsKind(scripted([json({ error: { message: "forbidden" } }, 403)]).client.search("x"), "auth", /rejected the API key: forbidden/);
  await rejectsKind(scripted([new Response("", { status: 401 })]).client.search("x"), "auth", /: unauthorized$/);
  await rejectsKind(scripted([json({}, 502)]).client.search("x"), "protocol", /HTTP 502/);
  await rejectsKind(scripted([json({ jsonrpc: "2.0", id: 1, error: { code: -1, message: "boom" } })]).client.search("x"), "protocol", /Skill Store error: boom/);
  await rejectsKind(scripted([new Response("not json", { status: 200 })]).client.search("x"), "protocol", /returned no result/);
  await rejectsKind(scripted([toolResult({}, { isError: true, structuredContent: { available: false, reason: "takedown" } })]).client.getSkill("a/b-1"), "unavailable", /reason: takedown/);
  await rejectsKind(scripted([toolResult({}, { isError: true, structuredContent: undefined })]).client.search("x"), "protocol", /search_skills failed/);
});

test("client: timeouts and network failures are named, with the sandbox advice", async () => {
  const timeout = Object.assign(new Error("aborted"), { name: "TimeoutError" });
  await rejectsKind(scripted([timeout]).client.search("x"), "timeout");
  const refused = Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
  await rejectsKind(scripted([refused]).client.search("x"), "network", /store\.test: the connection was refused \(ECONNREFUSED\)/);

  const saved = process.env.HTTPS_PROXY;
  process.env.HTTPS_PROXY = "http://proxy:3128";
  try {
    const msg = describeNetworkError(new Error("weird"), "not a url");
    assert.match(msg, /^Can't connect to the Skill Store at not a url: weird\./, "a raw endpoint and no code");
    assert.match(msg, /A proxy is configured \(HTTPS_PROXY\)/);
    assert.match(describeNetworkError({ code: "SELF_SIGNED_CERT_IN_CHAIN" }, "https://h/mcp"), /TLS certificate wasn't trusted/);
    assert.match(describeNetworkError({ cause: { code: "EPERM" } }, "https://h/mcp"), /blocked before it left this machine/);
  } finally {
    if (saved === undefined) delete process.env.HTTPS_PROXY;
    else process.env.HTTPS_PROXY = saved;
  }
});

test("client: get_skill_set falls back to the bare refs, and an unknown set is not_found either way the store says so", async () => {
  const bare = await scripted([toolResult({ ref: "skill-set/s-1", skill_refs: ["a/x-1", 7, "b/y-2"] })]).client.getSkillSet("skill-set/s-1");
  assert.equal(bare.title, "skill-set/s-1");
  assert.deepEqual(bare.steps, [
    { position: 1, ref: "a/x-1", title: "a/x-1" },
    { position: 2, ref: "b/y-2", title: "b/y-2" },
  ]);
  const ordered = await scripted([toolResult({ ref: "skill-set/s-1", skill_refs: [], steps: [{ position: 2, ref: "b" }, { ref: "a", position: 1, title: "A" }, { title: "no ref" }] })]).client.getSkillSet("skill-set/s-1");
  assert.deepEqual(ordered.steps.map((s) => [s.position, s.ref, s.title]), [[1, "a", "A"], [2, "b", "b"]]);

  await rejectsKind(scripted([toolResult({}, { isError: true, content: [{ type: "text", text: "No such set: skill-set/x" }], structuredContent: undefined })]).client.getSkillSet("skill-set/x"), "not_found");
  const textOnly = (text: string) => (req: Record<string, unknown>) => json({ jsonrpc: "2.0", id: req.id, result: { content: [{ type: "text", text }] } });
  await rejectsKind(scripted([textOnly("no such set")]).client.getSkillSet("skill-set/x"), "not_found", /No such skill set: skill-set\/x/);
  await rejectsKind(scripted([textOnly("something else")]).client.getSkillSet("skill-set/x"), "protocol", /Unexpected get_skill_set response/);
  await rejectsKind(scripted([json({}, 500)]).client.getSkillSet("skill-set/x"), "protocol", /HTTP 500/);
});

test("client parseSse: picks our id out of several events, else the last message", () => {
  const raw = 'event: message\ndata: {"jsonrpc":"2.0","method":"notifications/progress"}\n\nevent: message\ndata: {"jsonrpc":"2.0","id":7,"result":{}}\n\ndata: not json\n\n';
  assert.equal(parseSse(raw, 7)?.id, 7);
  assert.equal(parseSse(raw.replace('"id":7', '"id":8'), 7)?.id, 8, "falls back to the last parseable message");
  assert.equal(parseSse("\r\n\r\n", 1), undefined);
});

test("config: where the config and state dirs live (env, XDG, Claude Code's plugin data dir)", () => {
  assert.equal(configDir({ SS33_CONFIG_DIR: "/c" }), "/c");
  assert.equal(configDir({ XDG_CONFIG_HOME: "/x" }), join("/x", "ss33"));
  assert.equal(configDir({}), join(homedir(), ".config", "ss33"));
  assert.equal(stateDir({ SS33_STATE_DIR: "/s", CLAUDE_PLUGIN_DATA: "/p" }), "/s");
  assert.equal(stateDir({ CLAUDE_PLUGIN_DATA: "/p" }), "/p");
  assert.equal(stateDir({ XDG_STATE_HOME: "/x" }), join("/x", "ss33"));
  assert.equal(stateDir({}), join(homedir(), ".local", "state", "ss33"));
});

test("config: boolean and integer keys, and env flags beat the file", () => {
  const env = { SS33_CONFIG_DIR: tempDir() };
  setConfigValue("match.enabled", "yes", env);
  setConfigValue("match.chatApps", "0", env);
  setConfigValue("match.maxHintsPerSession", "5", env);
  setConfigValue("endpoint", "https://other/mcp", env);
  assert.deepEqual(loadConfig(env).match, { enabled: true, chatApps: false, minOverlap: 2, maxHintsPerSession: 5 });
  assert.throws(() => setConfigValue("match.maxHintsPerSession", "1.5", env), /non-negative integer/);
  assert.equal(loadConfig({ ...env, SS33_MATCH: "off", SS33_MATCH_CHAT_APPS: "on" }).match.enabled, false);
  assert.equal(loadConfig({ ...env, SS33_MATCH: "off", SS33_MATCH_CHAT_APPS: "on" }).match.chatApps, true);
  assert.equal(loadConfig({ ...env, SS33_ENDPOINT: "  " }).endpoint, "https://other/mcp", "a blank env value doesn't count");
  setConfigValue("endpoint", undefined, env);
  assert.equal(loadConfig(env).endpoint, "https://mcp.ss33.ai/mcp");
});

test("state: sessions survive a round trip, bad files read as empty, old ones are pruned, and logging never throws", () => {
  const dir = tempDir();
  assert.deepEqual(loadSession(dir, undefined), { suggested: [], hints: 0 });
  saveSession(dir, undefined, { suggested: ["x"], hints: 1 });
  assert.throws(() => readdirSync(join(dir, "sessions")), "no session id, nothing written");

  saveSession(dir, "old", { suggested: ["a/b-1"], hints: 1 });
  const [oldFile] = readdirSync(join(dir, "sessions"));
  const tenDaysAgo = (Date.now() - 10 * 24 * 3600 * 1000) / 1000;
  utimesSync(join(dir, "sessions", oldFile!), tenDaysAgo, tenDaysAgo);
  saveSession(dir, "new", { suggested: ["c/d-2"], hints: 2 });
  assert.deepEqual(loadSession(dir, "new"), { suggested: ["c/d-2"], hints: 2 });
  assert.deepEqual(loadSession(dir, "old"), { suggested: [], hints: 0 }, "a week-old session is pruned");

  const [newFile] = readdirSync(join(dir, "sessions"));
  writeFileSync(join(dir, "sessions", newFile!), JSON.stringify({ suggested: "nope", hints: "x" }));
  assert.deepEqual(loadSession(dir, "new"), { suggested: [], hints: 0 });

  const notADir = join(tempDir(), "file");
  writeFileSync(notADir, "");
  assert.doesNotThrow(() => debugLog(notADir, "goes nowhere"));
  debugLog(dir, "one");
  debugLog(dir, "two");
  assert.match(readFileSync(join(dir, "hook.log"), "utf8"), /^\S+ one\n\S+ two\n$/);
});

test("events: session start records the hook's view for `doctor`, and a key that can't be copied is logged, not thrown", async () => {
  const env = { SS33_CONFIG_DIR: tempDir(), SS33_STATE_DIR: tempDir(), SS33_PLUGIN_API_KEY: "sk-hermes" };
  assert.equal(await hermesHook("session-start", "", { env }), "");
  const seen = readHookStatus(env);
  assert.equal(seen?.harness, "hermes");
  assert.equal(seen?.apiKeySet, true);
  assert.equal(loadConfig({ SS33_CONFIG_DIR: env.SS33_CONFIG_DIR }).apiKey, "sk-hermes", "copied for /ss33 commands");

  // The config "dir" is a file: copying the key fails, the hook carries on.
  const blocked = join(tempDir(), "file");
  writeFileSync(blocked, "");
  const state = tempDir();
  assert.doesNotThrow(() => onSessionStarted({ harness: "test" }, { env: { SS33_CONFIG_DIR: blocked, SS33_STATE_DIR: state, CLAUDE_PLUGIN_OPTION_API_KEY: "sk-x" } }));
  assert.match(readFileSync(join(state, "hook.log"), "utf8"), /\[test\] could not copy the plugin's API key: /);
});

test("install: the installed description comes from whichever copy is left; a store error during update is reported per skill", async () => {
  const dir = tempDir();
  mkdirSync(join(dir, ".git"));
  const skills = { "acme/vitest-testing-1": SKILL_MD };
  await install(fakeClient({ skills }), dir, "acme/vitest-testing-1", { targets: ["claude", "agents"] });
  rmSync(join(dir, ".claude/skills/vitest-testing/SKILL.md"));
  assert.deepEqual(installedSkills(dir), [{ ref: "acme/vitest-testing-1", name: "vitest-testing", description: "Modern TypeScript testing with Vitest." }]);
  rmSync(join(dir, ".agents/skills/vitest-testing/SKILL.md"));
  assert.equal(installedSkills(dir)[0]!.description, "", "no copy left");

  const results = await update(fakeClient({ skills, status: 500 }), dir, { apply: true });
  assert.equal(results[0]!.state, "error");
  assert.match(results[0]!.error ?? "", /HTTP 500/);
});
