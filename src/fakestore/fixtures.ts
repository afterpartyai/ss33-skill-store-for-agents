/**
 * Skill fixtures for the fake store: a JSON file `{ "skills": [ScriptedSkill…] }`. A skill may give
 * `contentFile` (relative to the fixture) instead of inline `content`, so SKILL.md bodies stay readable.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { ScriptedSkill } from "./server.js";

type FixtureSkill = ScriptedSkill & { contentFile?: string };

export function loadSkillFixture(path: string): ScriptedSkill[] {
  const raw = JSON.parse(readFileSync(path, "utf8")) as { skills?: FixtureSkill[] };
  const base = dirname(resolve(path));
  return (raw.skills ?? []).map(({ contentFile, ...s }) => (contentFile ? { ...s, content: readFileSync(resolve(base, contentFile), "utf8") } : s));
}
