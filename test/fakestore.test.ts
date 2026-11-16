import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { StoreClient, StoreError } from "../src/core/client.js";
import { loadSkillFixture } from "../src/fakestore/fixtures.js";
import { startFakeStore, type FakeStore } from "../src/fakestore/server.js";
import { tempDir } from "./helpers.js";

const FIXTURE = join(process.cwd(), "test/fixtures/store/basic.json");
const open: FakeStore[] = [];
after(() => Promise.all(open.map((s) => s.close())));

async function store(opts: Parameters<typeof startFakeStore>[0] = {}): Promise<FakeStore> {
  const s = await startFakeStore(opts);
  open.push(s);
  return s;
}

const client = (s: FakeStore, extra: Partial<ConstructorParameters<typeof StoreClient>[0]> = {}) => new StoreClient({ endpoint: s.url, ...extra });

async function rejectsKind(p: Promise<unknown>, kind: string): Promise<void> {
  await assert.rejects(p, (err: unknown) => err instanceof StoreError && err.kind === kind);
}

test("fake store: scripted skills mirror the real store's shapes", async () => {
  const s = await store({ skills: loadSkillFixture(FIXTURE) });
  const c = client(s);

  const res = await c.search("set up a github actions ci pipeline", { limit: 3 });
  assert.equal(res.found, true);
  assert.equal(res.candidates[0]?.ref, "acme/github-actions-ci-1001");
  assert.equal(res.candidates[0]?.available, true);

  const slides = await c.search("make powerpoint slides", { limit: 3 });
  assert.equal(slides.candidates.find((x) => x.ref === "restricted/pptx-creator-1006")?.available, false);

  assert.match(await c.getSkill("acme/vitest-testing-1002"), /^---\nname: vitest-testing/);
  const mcp = await c.fetchSkill("acme/mcp-builder-1007");
  assert.equal(mcp.filesNotStored, true);
  assert.match(mcp.sourceUrl ?? "", /mcp-builder$/);
  assert.match(mcp.markdown, /Skill Store does not carry/);
  await rejectsKind(c.fetchSkill("restricted/pptx-creator-1006"), "unavailable");
  await rejectsKind(c.fetchSkill("nope/nope-1"), "not_found");
  assert.equal((await c.search("zzz qqq xylophone")).found, false);
});

test("fake store: emulates keys, the free tier and rate limiting", async () => {
  const s = await store({ skills: loadSkillFixture(FIXTURE), auth: { keys: ["good-key"], freeTierPerMinute: 2 } });
  await rejectsKind(client(s, { apiKey: "bad-key" }).search("github actions ci"), "auth");

  const keyed = await client(s, { apiKey: "good-key" }).search("github actions ci");
  assert.equal(keyed.storeNote, undefined, "no free-tier note with a key");

  const anon = client(s);
  assert.match((await anon.search("github actions ci")).storeNote ?? "", /Free tier: 1 free searches left/);
  await anon.search("github actions ci");
  assert.equal((await anon.search("github actions ci")).limited, true);
  assert.deepEqual(new Set(s.calls.map((x) => x.auth)), new Set(["rejected", "key", "anonymous"]));
  assert.ok(!JSON.stringify(s.calls).includes("good-key"), "keys are never stored in the call log");
});

test("fake store: faults (slow, HTTP error, malformed, hang-up) and one-shot faults", async () => {
  const s = await store({ skills: loadSkillFixture(FIXTURE) });
  const c = client(s, { timeoutMs: 200 });

  s.setFault({ latencyMs: 500 });
  await rejectsKind(c.search("github actions ci"), "timeout");
  s.setFault({ status: 500 });
  await rejectsKind(c.search("github actions ci"), "protocol");
  s.setFault({ malformed: true });
  await rejectsKind(c.search("github actions ci"), "protocol");
  s.setFault({ hangup: true });
  await rejectsKind(c.search("github actions ci"), "network");
  s.setFault({ limited: true, times: 1 });
  assert.equal((await c.search("github actions ci")).limited, true);
  assert.equal((await c.search("github actions ci")).found, true, "a times:1 fault clears itself");
  s.setFault({ status: 502, tools: ["get_skill"] });
  assert.equal((await c.search("github actions ci")).found, true, "tool-scoped fault leaves other tools alone");
  await rejectsKind(c.getSkill("acme/vitest-testing-1002"), "protocol");
});

test("fake store: records from an upstream, replays offline, never forwards outcome reports", async () => {
  const upstream = await store({ skills: loadSkillFixture(FIXTURE), auth: { keys: ["upstream-key"] } });
  const dir = tempDir();
  const recorder = await store({ cassetteDir: dir, record: { upstream: upstream.url, apiKey: "upstream-key" } });
  const rc = client(recorder);

  const live = await rc.search("set up a github actions ci pipeline", { limit: 2 });
  await rc.getSkill("acme/github-actions-ci-1001");
  await rejectsKind(rc.fetchSkill("restricted/pptx-creator-1006"), "unavailable");
  await rc.callTool("report_skill_outcome", { skill_ref: "acme/github-actions-ci-1001", worked: true, notes: "test" });
  assert.deepEqual(recorder.calls.map((x) => x.source), ["upstream", "upstream", "upstream", "captured"]);
  assert.equal(upstream.calls.filter((x) => x.tool === "report_skill_outcome").length, 0, "outcome reports stay local");
  assert.equal(recorder.outcomes.length, 1);

  const files = readdirSync(dir, { recursive: true }).map(String).filter((f) => f.endsWith(".json"));
  assert.equal(files.length, 3);
  const all = files.map((f) => readFileSync(join(dir, f), "utf8")).join("\n");
  assert.ok(!all.includes("upstream-key"), "the API key is never written to cassettes");

  await upstream.close();
  const replay = await store({ cassetteDir: dir });
  const rp = client(replay);
  assert.deepEqual(await rp.search("set   up a github actions ci pipeline", { limit: 2 }), live, "whitespace doesn't change the key");
  assert.match(await rp.getSkill("acme/github-actions-ci-1001"), /GitHub Actions CI/);
  await rejectsKind(rp.fetchSkill("restricted/pptx-creator-1006"), "unavailable");
  await rejectsKind(rp.search("something never recorded"), "protocol");
  assert.equal(replay.misses.length, 1, "misses are listed so a test can show what to record");
});
