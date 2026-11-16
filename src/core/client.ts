/**
 * Minimal MCP-over-HTTP client for the ss33 Skill Store.
 *
 * The store is an MCP server (streamable HTTP). We call its tools directly instead of
 * going through the model, which is the point of the plugin: no tokens spent on search.
 */

export interface Candidate {
  ref: string;
  title: string;
  publisher?: string;
  what_it_does?: string;
  when_to_use?: string;
  why_suggested?: string;
  fit_notes?: string;
  requires?: string;
  /** False when the store can't serve the skill (e.g. its licence forbids redistribution). Absent on older stores. */
  available?: boolean;
}

/** What get_skill returns. `files` are supporting files the store carries; `filesNotStored` means it has none but the author does. */
export interface FetchedSkill {
  markdown: string;
  files: { path: string; content: string }[];
  filesNotStored: boolean;
  sourceUrl?: string;
}

export interface SearchResult {
  found: boolean;
  candidates: Candidate[];
  /** True when the free tier's rate limit stopped the search. */
  limited: boolean;
  message?: string;
  storeNote?: string;
}

export type StoreErrorKind = "auth" | "not_found" | "unavailable" | "network" | "timeout" | "protocol";

export class StoreError extends Error {
  constructor(
    message: string,
    readonly kind: StoreErrorKind,
    /** For "unavailable": where the author publishes the skill. */
    readonly sourceUrl?: string,
  ) {
    super(message);
    this.name = "StoreError";
  }
}

export interface ClientOptions {
  endpoint: string;
  apiKey?: string;
  timeoutMs?: number;
  clientName?: string;
  clientVersion?: string;
  fetchImpl?: typeof fetch;
}

const PROTOCOL_VERSION = "2025-06-18";

interface RpcResponse {
  id?: number | string;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}

export class StoreClient {
  private sessionId: string | undefined;
  private nextId = 1;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: ClientOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async search(query: string, options: { limit?: number; area?: string; tier?: string } = {}): Promise<SearchResult> {
    const args: Record<string, unknown> = { query, limit: options.limit ?? 3 };
    if (options.area) args.area = options.area;
    if (options.tier) args.tier = options.tier;
    const { data } = await this.callTool("search_skills", args);
    const d = (data ?? {}) as Record<string, unknown>;
    const candidates = Array.isArray(d.candidates) ? (d.candidates as Candidate[]).filter((c) => c && typeof c.ref === "string") : [];
    return {
      found: Boolean(d.found) && candidates.length > 0,
      candidates,
      limited: Boolean(d.limited),
      ...(typeof d.message === "string" ? { message: d.message } : {}),
      ...(typeof d.store_note === "string" ? { storeNote: d.store_note } : {}),
    };
  }

  /**
   * Fetches a skill. Skills with supporting files come with structuredContent
   * ({available, skill_md, files, files_not_stored, source_url}); others are plain text. A bad ref is still
   * reported as a normal text result, so we check the shape.
   */
  async fetchSkill(ref: string): Promise<FetchedSkill> {
    const { text, data } = await this.callTool("get_skill", { skill_ref: ref });
    const d = (data && typeof data === "object" ? data : {}) as Record<string, unknown>;
    const markdown = typeof d.skill_md === "string" ? d.skill_md : text;
    if (!markdown.trimStart().startsWith("---")) {
      if (/no such skill/i.test(text)) throw new StoreError(`No such skill: ${ref}`, "not_found");
      throw new StoreError(`Unexpected get_skill response for ${ref}: ${text.slice(0, 200)}`, "protocol");
    }
    const files = Array.isArray(d.files)
      ? (d.files as Record<string, unknown>[]).filter((f) => f && typeof f.path === "string" && typeof f.content === "string").map((f) => ({ path: f.path as string, content: f.content as string }))
      : [];
    return {
      markdown,
      files,
      filesNotStored: d.files_not_stored === true,
      ...(typeof d.source_url === "string" ? { sourceUrl: d.source_url } : {}),
    };
  }

  /** The SKILL.md markdown only. */
  async getSkill(ref: string): Promise<string> {
    return (await this.fetchSkill(ref)).markdown;
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<{ text: string; data: unknown }> {
    const result = await this.rpc("tools/call", { name, arguments: args });
    const content = Array.isArray(result.content) ? (result.content as { type?: string; text?: string }[]) : [];
    const text = content.filter((c) => c.type === "text" && typeof c.text === "string").map((c) => c.text).join("\n");
    const sc = result.structuredContent as Record<string, unknown> | undefined;
    if (result.isError) {
      if (sc && sc.available === false) {
        const what = typeof args.skill_ref === "string" ? `"${args.skill_ref}"` : "This skill";
        const why = sc.reason === "licence" || sc.reason === "license" ? "its licence doesn't allow redistribution" : `reason: ${String(sc.reason ?? "unknown")}`;
        throw new StoreError(`${what} isn't available from the Skill Store (${why}).`, "unavailable", typeof sc.source_url === "string" ? sc.source_url : undefined);
      }
      throw new StoreError(`${name} failed: ${text.slice(0, 300)}`, "protocol");
    }
    let data: unknown = result.structuredContent;
    if (data === undefined) {
      try {
        data = JSON.parse(text);
      } catch {
        data = undefined;
      }
    }
    return { text, data };
  }

  private async rpc(method: string, params: unknown, retried = false): Promise<Record<string, unknown>> {
    const res = await this.post({ jsonrpc: "2.0", id: this.nextId++, method, params });
    // The store currently answers without a session. If that ever changes, initialise once and retry.
    const needsSession = res.status === 400 || res.status === 404 || (res.body?.error && /session/i.test(res.body.error.message));
    if (needsSession && !retried && !this.sessionId) {
      await this.initialize();
      return this.rpc(method, params, true);
    }
    if (res.status === 401 || res.status === 403) {
      const msg = res.body?.error?.message ?? "unauthorized";
      throw new StoreError(`Skill Store rejected the API key: ${msg}`, "auth");
    }
    if (res.status >= 400) throw new StoreError(`Skill Store HTTP ${res.status}`, "protocol");
    if (res.body?.error) throw new StoreError(`Skill Store error: ${res.body.error.message}`, "protocol");
    if (!res.body?.result) throw new StoreError("Skill Store returned no result", "protocol");
    return res.body.result;
  }

  private async initialize(): Promise<void> {
    const res = await this.post({
      jsonrpc: "2.0",
      id: this.nextId++,
      method: "initialize",
      params: {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: this.opts.clientName ?? "ss33-cli", version: this.opts.clientVersion ?? "0.0.0" },
      },
    });
    if (res.status >= 400 || !res.body?.result) throw new StoreError(`MCP initialize failed (HTTP ${res.status})`, "protocol");
    await this.post({ jsonrpc: "2.0", method: "notifications/initialized" });
  }

  private async post(body: Record<string, unknown>): Promise<{ status: number; body: RpcResponse | undefined }> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": PROTOCOL_VERSION,
    };
    if (this.opts.apiKey) headers.Authorization = `Bearer ${this.opts.apiKey}`;
    if (this.sessionId) headers["Mcp-Session-Id"] = this.sessionId;
    let res: Response;
    try {
      res = await this.fetchImpl(this.opts.endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.opts.timeoutMs ?? 10_000),
      });
    } catch (err) {
      const name = (err as Error)?.name;
      if (name === "TimeoutError" || name === "AbortError") throw new StoreError("Skill Store request timed out", "timeout");
      throw new StoreError(describeNetworkError(err, this.opts.endpoint), "network");
    }
    const sid = res.headers.get("mcp-session-id");
    if (sid) this.sessionId = sid;
    const raw = await res.text();
    if (!raw.trim()) return { status: res.status, body: undefined };
    const type = res.headers.get("content-type") ?? "";
    return { status: res.status, body: type.includes("text/event-stream") ? parseSse(raw, body.id) : safeJson(raw) };
  }
}

/**
 * Node's fetch only says "fetch failed"; the reason is in `cause.code`. Sandboxes that allow only
 * approved domains (Claude Cowork, claude.ai code execution) or none (Codex's default sandbox) are the common case, so say so and how to fix it.
 */
export function describeNetworkError(err: unknown, endpoint: string): string {
  let host = endpoint;
  try {
    host = new URL(endpoint).host;
  } catch {
    // keep the raw endpoint
  }
  const cause = (err as { cause?: { code?: string; message?: string } })?.cause;
  const code = cause?.code ?? (err as { code?: string })?.code;
  const reasons: [RegExp, string][] = [
    [/^(ENOTFOUND|EAI_AGAIN)$/, "the domain name couldn't be resolved"],
    [/^ECONNREFUSED$/, "the connection was refused"],
    [/^(ECONNRESET|EPIPE|UND_ERR_SOCKET)$/, "the connection was closed before the store answered"],
    [/^(ETIMEDOUT|UND_ERR_CONNECT_TIMEOUT)$/, "the connection timed out"],
    [/^(ENETUNREACH|EHOSTUNREACH)$/, "there is no network route to it"],
    // Codex's default sandbox refuses outbound connections this way (verified with Codex 0.167).
    [/^(EPERM|EACCES)$/, "the connection was blocked before it left this machine, usually by a sandbox"],
    [/CERT|SELF_SIGNED|UNABLE_TO_VERIFY/, "its TLS certificate wasn't trusted, which usually means a proxy is inspecting traffic"],
  ];
  const reason = (code && reasons.find(([re]) => re.test(code))?.[1]) ?? cause?.message ?? (err as Error)?.message ?? String(err);
  const proxy = process.env.HTTPS_PROXY || process.env.https_proxy;
  return [
    `Can't connect to the Skill Store at ${host}: ${reason}${code ? ` (${code})` : ""}.`,
    "This usually means outbound network access is restricted where this runs: Codex's default sandbox blocks the network, Claude Cowork and claude.ai sandboxes only allow approved domains, and company firewalls or proxies can block it too.",
    "- In Codex: run the command again with escalated permissions (outside the sandbox) and approve it.",
    `- In Cowork or claude.ai: an organization Owner can add ${host} to the domains allowed for code execution in the organization's settings.`,
    "- Elsewhere: check the internet connection, firewall and proxy settings, then try again.",
    ...(proxy ? ["- A proxy is configured (HTTPS_PROXY). The ss33 CLI connects directly and doesn't use it yet."] : []),
  ].join("\n");
}

function safeJson(raw: string): RpcResponse | undefined {
  try {
    return JSON.parse(raw) as RpcResponse;
  } catch {
    return undefined;
  }
}

/** Picks the JSON-RPC response with our id out of an SSE stream. */
export function parseSse(raw: string, id: unknown): RpcResponse | undefined {
  let last: RpcResponse | undefined;
  for (const event of raw.split(/\r?\n\r?\n/)) {
    const data = event
      .split(/\r?\n/)
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).trimStart())
      .join("\n");
    const msg = data ? safeJson(data) : undefined;
    if (!msg) continue;
    if (id !== undefined && msg.id === id) return msg;
    last = msg;
  }
  return last;
}
