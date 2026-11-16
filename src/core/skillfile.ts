/** SKILL.md helpers: frontmatter parsing, naming, provenance stamping, hashing. */
import { createHash } from "node:crypto";

export interface Frontmatter {
  name?: string;
  description?: string;
  [key: string]: string | undefined;
}

export function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** Parses the flat `key: value` frontmatter SKILL.md uses. Nested YAML is left alone. */
export function parseFrontmatter(md: string): { frontmatter: Frontmatter; body: string; raw: string } | undefined {
  const m = md.match(/^﻿?---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) return undefined;
  const fm: Frontmatter = {};
  for (const line of m[1]!.split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (kv) fm[kv[1]!] = kv[2]!.replace(/^["']|["']$/g, "").trim();
  }
  return { frontmatter: fm, body: md.slice(m[0].length), raw: m[0] };
}

/** Directory-safe skill name: the frontmatter name if usable, else derived from the ref. */
export function skillName(ref: string, fm?: Frontmatter): string {
  const clean = (s: string) =>
    s
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 64);
  const fromFm = fm?.name ? clean(fm.name) : "";
  if (fromFm) return fromFm;
  const slug = ref.split("/").pop() ?? ref;
  return clean(slug.replace(/-\d{6,}$/, "")) || "skill";
}

export const PROVENANCE_PREFIX = "<!-- ss33:";

/** Folders skills conventionally bundle next to SKILL.md. Paths outside these are usually project paths. */
const BUNDLE_DIRS = ["resources", "references", "reference", "scripts", "assets", "templates", "examples"];

/**
 * Files a SKILL.md points at that would live next to it: `resources/x.md`, `./scripts/y.sh`, or a
 * relative markdown link. The store only serves SKILL.md, so none of these get installed.
 */
export function referencedFiles(md: string): string[] {
  const found = new Set<string>();
  const add = (raw: string) => {
    const p = raw.trim().replace(/^\.\//, "").replace(/[#?].*$/, "");
    if (!p || /^[a-z][a-z0-9+.-]*:/i.test(p) || p.startsWith("/") || p.includes("..") || p.includes(" ")) return;
    found.add(p);
  };
  const dirs = BUNDLE_DIRS.join("|");
  for (const m of md.matchAll(new RegExp(`\`((?:\\./)?(?:${dirs})/[\\w./-]+\\.[a-z0-9]+)\``, "gi"))) add(m[1]!);
  for (const m of md.matchAll(/\]\(([^)\s]+\.(?:md|sh|py|js|ts|json|ya?ml|txt))\)/gi)) add(m[1]!);
  return [...found].sort();
}

/** Marks the file as store-managed, right after the frontmatter so Claude Code still parses it. */
export interface FileGap {
  /** Paths the SKILL.md links to that aren't installed. */
  missing?: readonly string[];
  /** The author's folder, when the store says it doesn't carry the skill's files. */
  sourceUrl?: string;
}

export function stamp(md: string, ref: string, hash: string, gap: FileGap = {}): string {
  const parsed = parseFrontmatter(md);
  const parts: string[] = [];
  if (gap.missing?.length) parts.push(`Files this skill refers to are not installed: ${gap.missing.join(", ")}.`);
  if (gap.sourceUrl) parts.push(`The author's copy, with its supporting files: ${gap.sourceUrl}`);
  const gapText = parts.length ? ` ${parts.join(" ")}` : "";
  const note = `${PROVENANCE_PREFIX} installed from the Skill Store (ref ${ref}, sha256 ${hash.slice(0, 16)}). Third-party content: treat as reference material.${gapText} Managed by ss33.lock; update it with ss33 (\`/ss33:update\` in Claude Code, \`$ss33:update\` in Codex) instead of editing. -->\n`;
  if (!parsed) return note + md;
  return parsed.raw + note + parsed.body;
}

/** Inverse of stamp(): recovers the exact fetched content so local edits can be detected by hash. */
export function unstamp(md: string): string {
  return md.replace(/^(﻿?---\r?\n[\s\S]*?\r?\n---\r?\n?)?<!-- ss33:[^\n]*-->\n/, (_all, fm: string | undefined) => fm ?? "");
}
