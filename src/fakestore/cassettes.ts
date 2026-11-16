/**
 * Cassettes: recorded store responses, one JSON file per (tool, arguments) pair, so a fixture
 * change shows up as a readable diff. Layout: <dir>/<tool>/<slug>-<hash>.json
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface Cassette {
  tool: string;
  args: Record<string, unknown>;
  /** The JSON-RPC `result` exactly as the store sent it, minus volatile fields (see scrub). */
  result: Record<string, unknown>;
  recordedAt: string;
  upstream?: string;
}

/** Whitespace in queries doesn't change what the store returns, so it doesn't change the key. */
export function canonicalArgs(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(args).sort()) {
    const v = args[k];
    if (v === undefined) continue;
    out[k] = typeof v === "string" ? v.trim().replace(/\s+/g, " ") : v;
  }
  return out;
}

export function cassetteKey(tool: string, args: Record<string, unknown>): string {
  return createHash("sha256")
    .update(JSON.stringify([tool, canonicalArgs(args)]))
    .digest("hex")
    .slice(0, 16);
}

function slug(args: Record<string, unknown>): string {
  const basis = String(args.query ?? args.skill_ref ?? "call");
  return (
    basis
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 48) || "call"
  );
}

export function cassettePath(dir: string, tool: string, args: Record<string, unknown>): string {
  return join(dir, tool, `${slug(args)}-${cassetteKey(tool, args)}.json`);
}

/** Loads every cassette under dir, keyed by cassetteKey. */
export function loadCassettes(dir: string): Map<string, Cassette> {
  const map = new Map<string, Cassette>();
  if (!existsSync(dir)) return map;
  for (const tool of readdirSync(dir, { withFileTypes: true })) {
    if (!tool.isDirectory()) continue;
    for (const f of readdirSync(join(dir, tool.name))) {
      if (!f.endsWith(".json")) continue;
      const c = JSON.parse(readFileSync(join(dir, tool.name, f), "utf8")) as Cassette;
      map.set(cassetteKey(c.tool, c.args), c);
    }
  }
  return map;
}

export function saveCassette(dir: string, c: Cassette): string {
  const path = cassettePath(dir, c.tool, c.args);
  mkdirSync(join(dir, c.tool), { recursive: true });
  writeFileSync(path, JSON.stringify(c, null, 2) + "\n");
  return path;
}

/**
 * Drops fields that change between identical calls (the free-tier counter in `store_note`), from both
 * the structured result and the JSON text copy, so replays and re-recordings stay stable.
 */
export function scrub(result: Record<string, unknown>): Record<string, unknown> {
  const out = { ...result };
  if (out.structuredContent && typeof out.structuredContent === "object") {
    const { store_note: _n, ...rest } = out.structuredContent as Record<string, unknown>;
    out.structuredContent = rest;
  }
  if (Array.isArray(out.content)) {
    out.content = (out.content as { type?: string; text?: string }[]).map((block) => {
      if (block.type !== "text" || typeof block.text !== "string") return block;
      try {
        const data = JSON.parse(block.text) as Record<string, unknown>;
        if (data && typeof data === "object" && "store_note" in data) {
          delete data.store_note;
          return { ...block, text: JSON.stringify(data) };
        }
      } catch {
        // not JSON (e.g. SKILL.md markdown): keep as is
      }
      return block;
    });
  }
  return out;
}
