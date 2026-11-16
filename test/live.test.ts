/** Hits the real store. Opt-in: `npm run test:live` (uses SS33_API_KEY if set, else the free tier). */
import assert from "node:assert/strict";
import { test } from "node:test";
import { StoreClient } from "../src/core/client.js";
import { DEFAULT_ENDPOINT } from "../src/core/config.js";

const live = process.env.SS33_LIVE === "1";

test("live: search and get_skill against mcp.ss33.ai", { skip: !live && "set SS33_LIVE=1" }, async () => {
  const client = new StoreClient({ endpoint: process.env.SS33_ENDPOINT || DEFAULT_ENDPOINT, ...(process.env.SS33_API_KEY ? { apiKey: process.env.SS33_API_KEY } : {}) });
  const res = await client.search("write unit tests for a TypeScript project with vitest", { limit: 2 });
  if (res.limited) return; // free-tier limit: nothing to assert
  assert.ok(res.found && res.candidates.length > 0);
  const md = await client.getSkill(res.candidates[0]!.ref);
  assert.match(md, /^---\n[\s\S]*description:/);
});
