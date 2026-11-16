/**
 * A local stand-in for the ss33 Skill Store (MCP over HTTP), for tests and evals.
 *
 * Answers come from, in order:
 *   - search_skills: an exact cassette for this query (a recording beats a guess), then scripted skills,
 *     then the real store when recording;
 *   - get_skill: scripted skills (so tests can publish new versions), then cassettes, then recording.
 * Requests to /s/<name>/mcp are tagged with that scenario name in the call log.
 * Anything else is a "miss": an error by default, so a test never silently passes on an empty result.
 *
 * It mirrors the real store's shapes as of 2026-11-05 (see ss33-issues-files-and-licensing.md):
 * `available` on candidates; unavailable skills as isError + structuredContent; files_not_stored.
 * report_skill_outcome is captured and NEVER forwarded, so evals can't pollute the real store's data.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { parseSse } from "../core/client.js";
import { canonicalArgs, cassetteKey, loadCassettes, saveCassette, scrub, type Cassette } from "./cassettes.js";

export interface ScriptedSkill {
  ref: string;
  title: string;
  what_it_does?: string;
  when_to_use?: string;
  publisher?: string;
  /** Extra search terms that should find this skill. */
  keywords?: string[];
  /** SKILL.md. Omit, with `sourceUrl`, for a skill the store can't redistribute. */
  content?: string;
  available?: boolean;
  /** The author's folder (unavailable skills, or skills whose files the store doesn't carry). */
  sourceUrl?: string;
  filesNotStored?: boolean;
  files?: { path: string; content: string }[];
}

export interface Fault {
  /** Delay before answering, in ms. */
  latencyMs?: number;
  /** Answer with this HTTP status instead (e.g. 401, 500, 502). */
  status?: number;
  /** Answer searches with the store's rate-limit payload. */
  limited?: boolean;
  /** Answer 200 with a body that isn't JSON. */
  malformed?: boolean;
  /** Close the connection without answering. */
  hangup?: boolean;
  /** Only for these tools (default: every request). */
  tools?: string[];
  /** Apply to this many matching requests, then clear (default: until cleared). */
  times?: number;
}

export interface AuthOptions {
  /** Bearer keys the store accepts. A different key gets a 401, like the real store. */
  keys: string[];
  /** Anonymous searches allowed per minute before `limited` (the real free tier allows 5). */
  freeTierPerMinute?: number;
}

export interface FakeStoreOptions {
  port?: number;
  host?: string;
  skills?: ScriptedSkill[];
  /** Replay recorded responses from this directory (and save new ones here when recording). */
  cassetteDir?: string;
  /** Forward misses to the real store and save the answers as cassettes. Needs cassetteDir. */
  record?: { upstream: string; apiKey?: string };
  /** What to answer when nothing matches: "error" (default) or an empty result. */
  onMiss?: "error" | "empty";
  /** Emulate keys and the free tier. Without it, every request is accepted and nothing is rate limited. */
  auth?: AuthOptions;
}

export type CallSource = "scripted" | "cassette" | "upstream" | "miss" | "fault" | "captured" | "protocol";

export interface CallRecord {
  at: string;
  method: string;
  tool?: string;
  args?: Record<string, unknown>;
  /** How the request authenticated. The key itself is never stored. */
  auth: "key" | "anonymous" | "rejected";
  source: CallSource;
  /** Set when the request came in on /s/<scenario>/mcp, so concurrent agent runs can be told apart. */
  scenario?: string;
}

export interface FakeStore {
  url: string;
  port: number;
  calls: CallRecord[];
  misses: CallRecord[];
  outcomes: Record<string, unknown>[];
  /** Adds or replaces a scripted skill (e.g. publish a new version). */
  publish(skill: ScriptedSkill): void;
  unpublish(ref: string): void;
  setFault(fault: Fault | undefined): void;
  reset(): void;
  close(): Promise<void>;
}

/** The real store's server instructions and tool descriptions (as served on 2026-11-05), so MCP clients see the same text. */
export const STORE_INSTRUCTIONS = `The Skill Store holds ~60,000 skills: step-by-step procedures written by
practitioners and organisations, covering software, operations, data,
documents, finance, legal, health, animal care, marketing, design and more.

Search the store FIRST, before starting any task that produces a plan,
schedule, procedure, document, configuration or code in a particular domain,
even when you already know how to do it. A skill often carries specific
house rules, standards or hard-won details that general knowledge will not
reproduce, and the user may be relying on them. A search takes under a
second; when it returns found=false, carry on normally.

1. search_skills(query, area) — describe the TASK in a sentence or two.
   Returns a few candidates with what each does and why it was suggested.
   Also pass \`area\`, the one of these that best fits the task, so results
   from that area rank higher: Software Development; AI & Agents; Data & Analytics; Security; Business; Finance & Markets; Betting & Prediction Markets; Legal; Health & Life Sciences; Creative & Media; Science & Education; Personal & Home.
2. get_skill(skill_ref) — fetch the best candidate's SKILL.md and follow it,
   telling the user which skill you used. Only fetch a skill you will use.
3. report_skill_outcome(skill_ref, worked, notes) — after using a skill, say
   whether it helped and what was missing.`;

const AREAS = ["Software Development", "AI & Agents", "Data & Analytics", "Security", "Business", "Finance & Markets", "Betting & Prediction Markets", "Legal", "Health & Life Sciences", "Creative & Media", "Science & Education", "Personal & Home"];

const TOOLS = [
  {
    name: "search_skills",
    description:
      "Call this BEFORE starting a domain task (a plan, schedule,\nprocedure, document, configuration or code), even one you know how to do: a\nskill may carry specific rules general knowledge will not reproduce. `query`\nis a sentence or two describing the task. `area` is the subject area that best fits the\ntask; skills from that area rank higher (others are still returned). `limit`\n1-10 (default 3). Optional `tier` ('frontier' or 'small') for the model that\nwill follow the skill.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", title: "Query" },
        area: { type: "string", title: "Area", enum: AREAS },
        limit: { type: "integer", title: "Limit", minimum: 1, maximum: 10, default: 3 },
        tier: { type: "string", title: "Tier", enum: ["frontier", "small"] },
      },
      required: ["query"],
    },
  },
  {
    name: "get_skill",
    description:
      "Fetch a skill's SKILL.md by the `ref` from\nsearch_skills (e.g. \"oakoss/vitest-testing-18074849092\"). Returns the\nmarkdown to follow. Pass `model` (the model that will use the skill, e.g.\n\"qwen3.6-27b\") or `tier` (\"small\" for a local / on-device model with a short\ncontext): many skills have a short version written for small models. When\nthe store holds a skill's supporting files (references, templates, scripts)\nthey follow the SKILL.md, each under its path; when it does not,\n`files_not_stored` is true and `source_url` is the author's folder with them.\nA skill whose licence forbids redistribution comes back as an error\n(`available` false) with the author's link. To keep a skill for later, save\nit as .claude/skills/<name>/SKILL.md with its files beside it.",
    inputSchema: {
      type: "object",
      properties: { skill_ref: { type: "string", title: "Skill Ref" }, tier: { type: "string", title: "Tier", enum: ["frontier", "small"] }, model: { type: "string", title: "Model" } },
      required: ["skill_ref"],
    },
  },
  {
    name: "report_skill_outcome",
    description: "After using a skill: did it help with the\ntask? `notes` says what worked or what was missing or wrong.",
    inputSchema: {
      type: "object",
      properties: { skill_ref: { type: "string", title: "Skill Ref" }, worked: { type: "boolean", title: "Worked" }, notes: { type: "string", title: "Notes", default: "" } },
      required: ["skill_ref", "worked"],
    },
  },
];

function words(text: string): string[] {
  return text.toLowerCase().match(/[a-z0-9][a-z0-9.+#-]*/g) ?? [];
}

/**
 * Deliberately simple and independent of src/core/match.ts: if the fake store scored like our matcher,
 * matching tests would only check the code against itself.
 */
function scriptedSearch(skills: Iterable<ScriptedSkill>, query: string, limit: number): ScriptedSkill[] {
  // Score on the task only: the appended "Project context: languages: typescript…" would otherwise match
  // every fixture that mentions a language.
  const task = query.split(/\n\s*Project context:/)[0] ?? query;
  const q = new Set(words(task).filter((w) => w.length > 2));
  const scored: { s: ScriptedSkill; score: number }[] = [];
  for (const s of skills) {
    const hay = new Set(words(`${s.title} ${s.what_it_does ?? ""} ${(s.keywords ?? []).join(" ")}`));
    let score = 0;
    for (const w of q) if (hay.has(w)) score += 1;
    if (score > 0) scored.push({ s, score: score + (s.available === false ? -0.5 : 0) });
  }
  return scored.sort((a, b) => b.score - a.score || a.s.ref.localeCompare(b.s.ref)).slice(0, limit).map((x) => x.s);
}

function candidateOf(s: ScriptedSkill): Record<string, unknown> {
  return {
    ref: s.ref,
    title: s.title,
    publisher: s.publisher ?? s.ref.split("/")[0],
    what_it_does: s.what_it_does ?? "",
    when_to_use: s.when_to_use ?? "Intended outcome: write or change code.",
    why_suggested: "fake store",
    fit_notes: "fake store",
    requires: "not declared",
    available: s.available !== false,
    get: `/api/v1/ss33/skill/${s.ref}`,
  };
}

function toolResult(data: Record<string, unknown>, isError = false): Record<string, unknown> {
  return { content: [{ type: "text", text: JSON.stringify(data) }], structuredContent: data, isError };
}

function textResult(text: string, isError = false): Record<string, unknown> {
  return { content: [{ type: "text", text }], isError };
}

function scriptedGet(s: ScriptedSkill): Record<string, unknown> {
  if (s.available === false || s.content === undefined) {
    const message = `# ${s.title}\n\nThis skill's license does not allow redistribution, so the store does not serve its file. Get it from the author:\n\n${s.sourceUrl ?? ""}\n`;
    return { content: [{ type: "text", text: message }], isError: true, structuredContent: { available: false, reason: "licence", source_url: s.sourceUrl ?? null, message } };
  }
  const hasFileInfo = s.filesNotStored || (s.files?.length ?? 0) > 0;
  if (!hasFileInfo) return textResult(s.content);
  let md = s.content;
  if (s.filesNotStored) {
    md += `\n\n---\nThis skill has supporting files (references, templates or scripts) that the Skill Store does not carry. Links to them in this text will not resolve here; get them from the author's folder: ${s.sourceUrl ?? ""}\n`;
  }
  return {
    content: [{ type: "text", text: md }],
    isError: false,
    structuredContent: { available: true, skill_md: md, files: s.files ?? [], files_not_stored: Boolean(s.filesNotStored), ...(s.sourceUrl ? { source_url: s.sourceUrl } : {}) },
  };
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.setEncoding("utf8");
    req.on("data", (c: string) => (data += c));
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(text);
}

export async function startFakeStore(opts: FakeStoreOptions = {}): Promise<FakeStore> {
  const skills = new Map<string, ScriptedSkill>((opts.skills ?? []).map((s) => [s.ref, s]));
  const cassettes: Map<string, Cassette> = opts.cassetteDir ? loadCassettes(opts.cassetteDir) : new Map();
  if (opts.record && !opts.cassetteDir) throw new Error("record mode needs cassetteDir");
  const calls: CallRecord[] = [];
  const misses: CallRecord[] = [];
  const outcomes: Record<string, unknown>[] = [];
  const anonSearches: number[] = [];
  let fault: Fault | undefined;

  function takeFault(tool: string | undefined): Fault | undefined {
    if (!fault) return undefined;
    if (fault.tools && (!tool || !fault.tools.includes(tool))) return undefined;
    const f = fault;
    if (f.times !== undefined && --f.times <= 0) fault = undefined;
    return f;
  }

  async function forward(tool: string, args: Record<string, unknown>): Promise<Record<string, unknown> | undefined> {
    const rec = opts.record!;
    const headers: Record<string, string> = { "Content-Type": "application/json", Accept: "application/json, text/event-stream" };
    if (rec.apiKey) headers.Authorization = `Bearer ${rec.apiKey}`;
    const body = { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: tool, arguments: args } };
    const r = await fetch(rec.upstream, { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(20_000) });
    const raw = await r.text();
    if (!r.ok) throw new Error(`upstream HTTP ${r.status}`);
    const msg = (r.headers.get("content-type") ?? "").includes("text/event-stream") ? parseSse(raw, 1) : (JSON.parse(raw) as { result?: Record<string, unknown> });
    const result = msg?.result;
    if (!result) throw new Error("upstream returned no result");
    const sc = result.structuredContent as Record<string, unknown> | undefined;
    // Don't freeze a rate-limit answer into a cassette.
    if (sc?.limited) return result;
    const cassette: Cassette = { tool, args: canonicalArgs(args), result: scrub(result), recordedAt: new Date().toISOString(), upstream: rec.upstream };
    saveCassette(opts.cassetteDir!, cassette);
    cassettes.set(cassetteKey(tool, args), cassette);
    return cassette.result;
  }

  async function callTool(tool: string, args: Record<string, unknown>, auth: CallRecord["auth"]): Promise<{ result: Record<string, unknown>; source: CallSource }> {
    if (tool === "report_skill_outcome") {
      outcomes.push({ ...args, at: new Date().toISOString() });
      return { result: textResult("Thanks: outcome recorded (fake store; not forwarded)."), source: "captured" };
    }
    if (tool === "search_skills") {
      const exact = cassettes.get(cassetteKey(tool, args));
      if (exact) return { result: exact.result, source: "cassette" };
      if (opts.auth && auth === "anonymous") {
        const now = Date.now();
        while (anonSearches.length && now - anonSearches[0]! > 60_000) anonSearches.shift();
        const allowed = opts.auth.freeTierPerMinute ?? 5;
        if (anonSearches.length >= allowed) {
          const data = { candidates: [], found: false, limited: true, message: "Free-tier limit reached: try again in a minute, or use an API key." };
          return { result: toolResult(data), source: "scripted" };
        }
        anonSearches.push(now);
      }
      const limit = Math.min(Math.max(Number(args.limit ?? 3) || 3, 1), 10);
      const hits = scriptedSearch(skills.values(), String(args.query ?? ""), limit);
      const freeNote =
        opts.auth && auth === "anonymous"
          ? { store_note: `Free tier: ${Math.max((opts.auth.freeTierPerMinute ?? 5) - anonSearches.length, 0)} free searches left this minute from this address.` }
          : {};
      if (hits.length) return { result: toolResult({ found: true, candidates: hits.map(candidateOf), ...freeNote }), source: "scripted" };
      if (opts.record) {
        const result = await forward(tool, args);
        if (result) return { result, source: "upstream" };
      }
      if (skills.size && !opts.cassetteDir) {
        return { result: toolResult({ found: false, candidates: [], message: "No skill in the corpus covers this request well enough to recommend.", ...freeNote }), source: "scripted" };
      }
    }
    if (tool === "get_skill") {
      const ref = String(args.skill_ref ?? "");
      const s = skills.get(ref);
      if (s) return { result: scriptedGet(s), source: "scripted" };
      const recorded = cassettes.get(cassetteKey(tool, args));
      if (recorded) return { result: recorded.result, source: "cassette" };
      if (opts.record) {
        const result = await forward(tool, args);
        if (result) return { result, source: "upstream" };
      }
      if (skills.size && !opts.cassetteDir) {
        return { result: textResult(`Could not fetch skill ${ref}: no such skill (use a ref from search_skills)`), source: "scripted" };
      }
    }
    if (opts.onMiss === "empty") {
      const empty = tool === "search_skills" ? toolResult({ found: false, candidates: [] }) : textResult(`Could not fetch skill ${String(args.skill_ref)}: no such skill (use a ref from search_skills)`);
      return { result: empty, source: "miss" };
    }
    return { result: textResult(`fake store: no scripted skill or cassette for ${tool} ${JSON.stringify(canonicalArgs(args))}`, true), source: "miss" };
  }

  async function handleAdmin(req: IncomingMessage, res: ServerResponse, path: string): Promise<void> {
    const body = req.method === "POST" ? (JSON.parse((await readBody(req)) || "{}") as Record<string, unknown>) : {};
    if (path === "/_admin/calls" && req.method === "GET") return send(res, 200, { calls, misses, outcomes });
    if (path === "/_admin/reset" && req.method === "POST") return api.reset(), send(res, 200, { ok: true });
    if (path === "/_admin/fault" && req.method === "POST") return api.setFault(Object.keys(body).length ? (body as Fault) : undefined), send(res, 200, { ok: true });
    if (path === "/_admin/skills" && req.method === "POST") return api.publish(body as unknown as ScriptedSkill), send(res, 200, { ok: true });
    if (path === "/_admin/skills" && req.method === "DELETE") return api.unpublish(new URL(req.url ?? "", "http://x").searchParams.get("ref") ?? ""), send(res, 200, { ok: true });
    send(res, 404, { error: "unknown admin route" });
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const path = new URL(req.url ?? "/", "http://x").pathname;
    if (path.startsWith("/_admin/")) return handleAdmin(req, res, path);
    const route = path.match(/^(?:\/s\/([\w.-]+))?\/mcp$/);
    if (req.method !== "POST" || !route) return send(res, 404, { error: "POST /mcp (or /s/<scenario>/mcp)" });
    const scenario = route[1];

    const raw = await readBody(req);
    let msg: { id?: number | string; method?: string; params?: { name?: string; arguments?: Record<string, unknown> } };
    try {
      msg = JSON.parse(raw);
    } catch {
      return send(res, 400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } });
    }
    const method = msg.method ?? "";
    const tool = method === "tools/call" ? msg.params?.name : undefined;
    const args = msg.params?.arguments ?? {};

    const header = req.headers.authorization;
    let auth: CallRecord["auth"] = "anonymous";
    if (header !== undefined) {
      const key = header.replace(/^Bearer\s*/i, "").trim();
      auth = !opts.auth || (key && opts.auth.keys.includes(key)) ? "key" : "rejected";
    }
    const record: CallRecord = { at: new Date().toISOString(), method, ...(tool ? { tool, args } : {}), auth, source: "protocol", ...(scenario ? { scenario } : {}) };
    calls.push(record);

    const f = takeFault(tool);
    if (f) {
      record.source = "fault";
      if (f.latencyMs) await new Promise((r) => setTimeout(r, f.latencyMs));
      if (f.hangup) return void req.socket.destroy();
      if (f.malformed) return send(res, 200, "<html>not json", { "content-type": "application/json" });
      if (f.status) return send(res, f.status, { jsonrpc: "2.0", id: msg.id ?? null, error: { code: -32000, message: `fake store fault: HTTP ${f.status}` } });
      if (f.limited && tool === "search_skills") {
        return send(res, 200, { jsonrpc: "2.0", id: msg.id, result: toolResult({ candidates: [], found: false, limited: true, message: "Free-tier limit reached." }) });
      }
      // Latency only: carry on and answer normally.
      record.source = "protocol";
    }

    if (auth === "rejected") {
      return send(res, 401, { jsonrpc: "2.0", id: null, error: { code: -32600, message: "invalid or revoked Skill Store key; remove the Authorization header to use the free tier" } });
    }
    if (method === "notifications/initialized") return void res.writeHead(202).end();
    if (method === "initialize") {
      return send(res, 200, { jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: { listChanged: false } }, serverInfo: { name: "ss33-fake-store", version: "1" }, instructions: STORE_INSTRUCTIONS } }, { "mcp-session-id": "fake-session" });
    }
    if (method === "tools/list") return send(res, 200, { jsonrpc: "2.0", id: msg.id, result: { tools: TOOLS } });
    if (method === "tools/call" && tool) {
      try {
        const { result, source } = await callTool(tool, args, auth);
        record.source = source;
        if (source === "miss") misses.push(record);
        return send(res, 200, { jsonrpc: "2.0", id: msg.id, result });
      } catch (err) {
        record.source = "miss";
        misses.push(record);
        return send(res, 200, { jsonrpc: "2.0", id: msg.id, result: textResult(`fake store: upstream failed: ${(err as Error).message}`, true) });
      }
    }
    send(res, 200, { jsonrpc: "2.0", id: msg.id ?? null, error: { code: -32601, message: `method not found: ${method}` } });
  }

  const server: Server = createServer((req, res) => {
    handle(req, res).catch((err) => {
      if (!res.headersSent) send(res, 500, { error: String((err as Error)?.message ?? err) });
    });
  });
  await new Promise<void>((resolve) => server.listen(opts.port ?? 0, opts.host ?? "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;

  const api: FakeStore = {
    url: `http://${opts.host ?? "127.0.0.1"}:${port}/mcp`,
    port,
    calls,
    misses,
    outcomes,
    publish: (s) => void skills.set(s.ref, s),
    unpublish: (ref) => void skills.delete(ref),
    setFault: (f) => void (fault = f ? { ...f } : undefined),
    reset: () => {
      calls.length = 0;
      misses.length = 0;
      outcomes.length = 0;
      anonSearches.length = 0;
      fault = undefined;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
  return api;
}
