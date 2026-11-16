import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StoreClient, type Candidate } from "../src/core/client.js";

export function tempDir(prefix = "ss33-test-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

export const SKILL_MD = `---
name: vitest-testing
description: Modern TypeScript testing with Vitest.
---

# Vitest

Write tests.
`;

export function candidate(ref: string, title: string, what = ""): Candidate {
  return { ref, title, what_it_does: what };
}

interface FakeStore {
  skills?: Record<string, string>;
  candidates?: Candidate[];
  limited?: boolean;
  status?: number;
  calls?: { method: string; name?: string; args?: Record<string, unknown> }[];
  /** get_skill structuredContent per ref (skills with supporting files). */
  structured?: Record<string, Record<string, unknown>>;
  /** Refs the store can't serve, mapped to the author's source_url. */
  restricted?: Record<string, string>;
  sse?: boolean;
}

/** A fetch stand-in that speaks just enough of the store's JSON-RPC. */
export function fakeFetch(store: FakeStore): typeof fetch {
  return (async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { id?: number; method: string; params?: { name?: string; arguments?: Record<string, unknown> } };
    store.calls?.push({ method: body.method, ...(body.params?.name ? { name: body.params.name } : {}), ...(body.params?.arguments ? { args: body.params.arguments } : {}) });
    if (store.status && store.status !== 200) {
      return new Response(JSON.stringify({ error: { code: -32600, message: "invalid or revoked Skill Store key" } }), { status: store.status, headers: { "content-type": "application/json" } });
    }
    let result: unknown;
    if (body.method === "tools/call" && body.params?.name === "search_skills") {
      const data = store.limited
        ? { candidates: [], found: false, limited: true, message: "limit reached" }
        : { candidates: store.candidates ?? [], found: (store.candidates ?? []).length > 0 };
      result = { content: [{ type: "text", text: JSON.stringify(data) }], structuredContent: data, isError: false };
    } else if (body.method === "tools/call" && body.params?.name === "get_skill") {
      const ref = String(body.params.arguments?.skill_ref);
      const md = store.skills?.[ref];
      const source = store.restricted?.[ref];
      if (source !== undefined) {
        const message = `# ${ref}\n\nThis skill's license does not allow redistribution, so the store does not serve its file. Get it from the author:\n\n${source}\n`;
        result = { content: [{ type: "text", text: message }], isError: true, structuredContent: { available: false, reason: "licence", source_url: source, message } };
      } else {
        const structured = store.structured?.[ref];
        result = {
          content: [{ type: "text", text: md ?? `Could not fetch skill ${ref}: no such skill (use a ref from search_skills)` }],
          isError: false,
          ...(structured ? { structuredContent: { available: true, skill_md: md, files: [], files_not_stored: false, ...structured } } : {}),
        };
      }
    } else result = {};
    const payload = JSON.stringify({ jsonrpc: "2.0", id: body.id, result });
    return store.sse
      ? new Response(`event: message\ndata: ${payload}\n\n`, { status: 200, headers: { "content-type": "text/event-stream" } })
      : new Response(payload, { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}

export function fakeClient(store: FakeStore): StoreClient {
  return new StoreClient({ endpoint: "https://store.test/mcp", fetchImpl: fakeFetch(store) });
}
