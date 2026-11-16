/** Per-session memory for prompt matching: which skills we already suggested, so hints never repeat. */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface SessionState {
  suggested: string[];
  hints: number;
}

const MAX_AGE_MS = 7 * 24 * 3600 * 1000;

function sessionFile(dir: string, sessionId: string): string {
  return join(dir, "sessions", createHash("sha256").update(sessionId).digest("hex").slice(0, 32) + ".json");
}

export function loadSession(dir: string, sessionId: string | undefined): SessionState {
  if (!sessionId) return { suggested: [], hints: 0 };
  try {
    const s = JSON.parse(readFileSync(sessionFile(dir, sessionId), "utf8")) as Partial<SessionState>;
    return { suggested: Array.isArray(s.suggested) ? s.suggested : [], hints: Number(s.hints) || 0 };
  } catch {
    return { suggested: [], hints: 0 };
  }
}

export function saveSession(dir: string, sessionId: string | undefined, state: SessionState): void {
  if (!sessionId) return;
  mkdirSync(join(dir, "sessions"), { recursive: true });
  writeFileSync(sessionFile(dir, sessionId), JSON.stringify(state));
  pruneSessions(dir);
}

/** Opportunistic cleanup so the state dir doesn't grow forever. */
function pruneSessions(dir: string): void {
  const now = Date.now();
  try {
    for (const f of readdirSync(join(dir, "sessions"))) {
      const p = join(dir, "sessions", f);
      if (now - statSync(p).mtimeMs > MAX_AGE_MS) rmSync(p, { force: true });
    }
  } catch {
    /* best effort */
  }
}

/** Append-only debug log for hooks, which must never print errors into the user's session. */
export function debugLog(dir: string, message: string): void {
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "hook.log"), `${new Date().toISOString()} ${message}\n`, { flag: "a" });
  } catch {
    /* best effort */
  }
}
