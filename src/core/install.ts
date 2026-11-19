/**
 * Native skill install: Skill Store skills become regular SKILL.md files in the project, tracked in
 * `ss33.lock` with their content hash. Claude Code (and other harnesses that read SKILL.md) then
 * load them natively — only the description sits in context until the skill is needed.
 */
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync, readdirSync, rmdirSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import type { StoreClient } from "./client.js";
import { lineDiff } from "./diff.js";
import { parseFrontmatter, referencedFiles, sha256, skillName, stamp, unstamp } from "./skillfile.js";
import type { FetchedSkill } from "./client.js";

export type Target = "claude" | "agents";
export const TARGET_DIRS: Record<Target, string> = { claude: ".claude/skills", agents: ".agents/skills" };

export interface LockEntry {
  ref: string;
  sha256: string;
  /** Project-relative paths of every installed copy. */
  paths: string[];
  installedAt: string;
}

export interface Lock {
  version: 1;
  skills: Record<string, LockEntry>;
}

export const LOCK_FILE = "ss33.lock";

/**
 * ss33.lock is a committed project file, so a cloned repo's lock is untrusted: it could name `../../x`, an absolute
 * path, or reach outside through a symlinked folder. ss33 only ever reads, hashes, writes or deletes a path it would
 * create itself: `<.agents|.claude>/skills/<name>/SKILL.md` for that entry's name (the shape skillName produces), still
 * inside the project once symlinks are followed. Anything else is skipped and reported.
 */
const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Why ss33 won't touch this lock path, or undefined when it's one ss33 manages. */
export function lockPathProblem(root: string, name: string, rel: unknown): string | undefined {
  if (!SKILL_NAME.test(name)) return `"${name}" isn't a skill name ss33 creates`;
  if (typeof rel !== "string" || !Object.values(TARGET_DIRS).some((d) => rel === `${d}/${name}/SKILL.md`)) {
    return `not a path ss33 manages for "${name}"`;
  }
  if (!insideProject(root, join(root, rel))) return "leads outside the project through a symlink";
  return undefined;
}

/** The file, or its nearest existing parent, is inside the project once symlinks are followed. */
function insideProject(root: string, file: string): boolean {
  try {
    const realRoot = realpathSync(root);
    let p = file;
    while (!existsSync(p)) {
      const parent = dirname(p);
      if (parent === p) return false;
      p = parent;
    }
    const real = realpathSync(p);
    return real === realRoot || real.startsWith(realRoot.endsWith(sep) ? realRoot : realRoot + sep);
  } catch {
    return false;
  }
}

export interface IgnoredPath {
  path: string;
  reason: string;
}

/** An entry's paths split into the ones ss33 may use and the ones it ignores. */
export function lockPaths(root: string, name: string, entry: LockEntry): { paths: string[]; ignored: IgnoredPath[] } {
  const all: unknown[] = Array.isArray(entry?.paths) ? entry.paths : [];
  const paths: string[] = [];
  const ignored: IgnoredPath[] = [];
  for (const p of all) {
    const reason = lockPathProblem(root, name, p);
    if (reason) ignored.push({ path: String(p), reason });
    else paths.push(p as string);
  }
  return { paths, ignored };
}

function describeIgnored(ignored: IgnoredPath[]): string {
  return ignored.map((i) => `${i.path} (${i.reason})`).join(", ");
}

/** Explicit dir, then the harness's project dir, then the nearest ancestor with ss33.lock or .git. */
export function projectRoot(start: string, env: Record<string, string | undefined> = process.env, explicit?: string): string {
  if (explicit) return resolve(explicit);
  if (env.CLAUDE_PROJECT_DIR) return resolve(env.CLAUDE_PROJECT_DIR);
  let dir = resolve(start);
  for (;;) {
    if (existsSync(join(dir, LOCK_FILE)) || existsSync(join(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return resolve(start);
    dir = parent;
  }
}

export function readLock(root: string): Lock {
  try {
    const lock = JSON.parse(readFileSync(join(root, LOCK_FILE), "utf8")) as Lock;
    if (lock && lock.version === 1 && lock.skills && typeof lock.skills === "object") return lock;
  } catch {
    /* missing or unreadable: start fresh */
  }
  return { version: 1, skills: {} };
}

export function writeLock(root: string, lock: Lock): void {
  const skills = Object.fromEntries(Object.entries(lock.skills).sort(([a], [b]) => a.localeCompare(b)));
  if (!Object.keys(skills).length) {
    rmSync(join(root, LOCK_FILE), { force: true });
    return;
  }
  writeFileSync(join(root, LOCK_FILE), JSON.stringify({ version: 1, skills }, null, 2) + "\n");
}

/** Installed skills with the description from their SKILL.md, for "already covered" checks. */
export function installedSkills(root: string): { ref: string; name: string; description: string }[] {
  return Object.entries(readLock(root).skills).map(([name, entry]) => {
    let description = "";
    for (const p of lockPaths(root, name, entry).paths) {
      try {
        description = parseFrontmatter(readFileSync(join(root, p), "utf8"))?.frontmatter.description ?? "";
        if (description) break;
      } catch {
        /* missing copy: try the next */
      }
    }
    return { ref: entry.ref, name, description };
  });
}

export class InstallError extends Error {}

export interface InstallPlan {
  name: string;
  ref: string;
  sha256: string;
  description: string;
  paths: string[];
  content: string;
  /** Paths already on disk that ss33 doesn't manage. Installing over them needs --force. */
  conflicts: string[];
  /** Files the SKILL.md links to (resources/…, scripts/…) that the store doesn't serve. */
  missingFiles: string[];
  /** The store says it doesn't carry this skill's supporting files; they're at sourceUrl. */
  filesNotStored: boolean;
  sourceUrl?: string;
  /** Supporting files the store sent. Not installed yet: the store doesn't send them. */
  storeFiles: string[];
  replacing?: LockEntry;
}

export function planInstall(root: string, ref: string, skill: FetchedSkill, targets: Target[]): InstallPlan {
  const fetched = skill.markdown;
  const parsed = parseFrontmatter(fetched);
  if (!parsed?.frontmatter.description) throw new InstallError(`${ref} has no SKILL.md frontmatter description; refusing to install it`);
  const name = skillName(ref, parsed.frontmatter);
  const hash = sha256(fetched);
  const lock = readLock(root);
  const existing = lock.skills[name];
  if (existing && existing.ref !== ref) {
    throw new InstallError(`A different skill is already installed as "${name}" (${existing.ref}). Remove it first with \`ss33 remove ${name}\`.`);
  }
  const paths = targets.map((t) => `${TARGET_DIRS[t]}/${name}/SKILL.md`);
  const managed = new Set(existing ? lockPaths(root, name, existing).paths : []);
  const conflicts = paths.filter((p) => existsSync(join(root, p)) && !managed.has(p));
  const missingFiles = referencedFiles(parsed.body);
  const sourceUrl = skill.filesNotStored || missingFiles.length || skill.files.length ? skill.sourceUrl : undefined;
  return {
    name,
    ref,
    sha256: hash,
    description: parsed.frontmatter.description,
    paths,
    content: stamp(fetched, ref, hash, { missing: missingFiles, ...(sourceUrl ? { sourceUrl } : {}) }),
    conflicts,
    missingFiles,
    filesNotStored: skill.filesNotStored,
    ...(sourceUrl ? { sourceUrl } : {}),
    storeFiles: skill.files.map((f) => f.path),
    ...(existing ? { replacing: existing } : {}),
  };
}

export function applyInstall(root: string, plan: InstallPlan, opts: { force?: boolean } = {}): void {
  // A symlinked .agents/skills (or .claude/skills) in a cloned repo could send the write elsewhere. Checked first:
  // --force must not get past it.
  const outside = plan.paths.filter((p) => lockPathProblem(root, plan.name, p));
  if (outside.length) throw new InstallError(`Not installing: ${outside.join(", ")} would land outside the project (a symlinked folder). Nothing was changed.`);
  if (plan.conflicts.length && !opts.force) {
    throw new InstallError(`Not overwriting files ss33 doesn't manage: ${plan.conflicts.join(", ")} (use --force to replace them)`);
  }
  for (const p of plan.paths) {
    writable(p, () => {
      mkdirSync(dirname(join(root, p)), { recursive: true });
      writeFileSync(join(root, p), plan.content);
    });
  }
  const lock = readLock(root);
  const stale = (plan.replacing ? lockPaths(root, plan.name, plan.replacing).paths : []).filter((p) => !plan.paths.includes(p));
  for (const p of stale) removeSkillFile(root, p);
  lock.skills[plan.name] = { ref: plan.ref, sha256: plan.sha256, paths: plan.paths, installedAt: new Date().toISOString() };
  writeLock(root, lock);
}

export async function install(
  client: StoreClient,
  root: string,
  ref: string,
  opts: { targets: Target[]; force?: boolean; dryRun?: boolean },
): Promise<InstallPlan> {
  const plan = planInstall(root, ref, await client.fetchSkill(ref), opts.targets);
  if (!opts.dryRun) applyInstall(root, plan, opts);
  return plan;
}

const NOT_WRITABLE = new Set(["EACCES", "EPERM", "EROFS", "ENOENT"]);

/**
 * Codex's default sandbox keeps `.agents`, `.codex` and `.git` read-only even inside the workspace
 * (verified 2026-11-10: mkdir under `.agents` fails with ENOENT), so installs from Codex need an
 * approved escalation. Say that instead of printing a stack trace.
 */
function writable(rel: string, write: () => void): void {
  try {
    write();
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (!code || !NOT_WRITABLE.has(code)) throw err;
    throw new InstallError(
      `Can't write ${rel} (${code}). Nothing was changed in ${LOCK_FILE}. If this runs inside an agent's sandbox, it may keep that folder read-only ` +
        `(Codex protects .agents, .codex and .git): run the same command again with escalated permissions, outside the sandbox.`,
    );
  }
}

function removeSkillFile(root: string, rel: string): void {
  const file = join(root, rel);
  writable(rel, () => rmSync(file, { force: true }));
  // Remove the skill's folder if we emptied it; never touch anything else the user put there.
  const dir = dirname(file);
  try {
    if (!readdirSync(dir).length) rmdirSync(dir);
  } catch {
    /* already gone */
  }
}

/** Removes the skill's files and its lock entry. Paths ss33 doesn't manage are left alone and returned as `ignored`. */
export function remove(root: string, name: string): { entry: LockEntry; removed: string[]; ignored: IgnoredPath[] } {
  const lock = readLock(root);
  const entry = Object.prototype.hasOwnProperty.call(lock.skills, name) ? lock.skills[name] : undefined;
  if (!entry) throw new InstallError(`No skill named "${name}" in ${LOCK_FILE}`);
  const { paths, ignored } = lockPaths(root, name, entry);
  for (const p of paths) removeSkillFile(root, p);
  delete lock.skills[name];
  writeLock(root, lock);
  return { entry, removed: paths, ignored };
}

export type FileStatus = "ok" | "modified" | "missing" | "ignored";

export function status(root: string): { name: string; entry: LockEntry; files: { path: string; status: FileStatus; reason?: string }[] }[] {
  return Object.entries(readLock(root).skills).map(([name, entry]) => {
    const { paths, ignored } = lockPaths(root, name, entry);
    const files: { path: string; status: FileStatus; reason?: string }[] = paths.map((path) => {
      const full = join(root, path);
      if (!existsSync(full)) return { path, status: "missing" as const };
      return { path, status: sha256(unstamp(readFileSync(full, "utf8"))) === entry.sha256 ? ("ok" as const) : ("modified" as const) };
    });
    for (const i of ignored) files.push({ path: i.path, status: "ignored", reason: i.reason });
    return { name, entry, files };
  });
}

export interface UpdateResult {
  name: string;
  ref: string;
  state: "unchanged" | "available" | "updated" | "blocked-local-edits" | "error";
  diff?: string;
  error?: string;
}

/** Checks each installed skill against the store. Applies changes only with `apply`, and never over local edits unless forced. */
export async function update(
  client: StoreClient,
  root: string,
  opts: { names?: string[]; apply?: boolean; force?: boolean } = {},
): Promise<UpdateResult[]> {
  const results: UpdateResult[] = [];
  const statuses = new Map(status(root).map((s) => [s.name, s]));
  const lock = readLock(root);
  const names = opts.names?.length ? opts.names : Object.keys(lock.skills);
  for (const name of names) {
    const entry = Object.prototype.hasOwnProperty.call(lock.skills, name) ? lock.skills[name] : undefined;
    if (!entry) {
      results.push({ name, ref: "?", state: "error", error: `not in ${LOCK_FILE}` });
      continue;
    }
    const { paths, ignored } = lockPaths(root, name, entry);
    if (ignored.length) {
      results.push({
        name,
        ref: String(entry.ref),
        state: "error",
        error: `${LOCK_FILE} lists paths ss33 doesn't manage, so this skill was skipped: ${describeIgnored(ignored)}. Check where this lock came from.`,
      });
      continue;
    }
    try {
      const skill = await client.fetchSkill(entry.ref);
      const fetched = skill.markdown;
      const hash = sha256(fetched);
      const localEdits = statuses.get(name)?.files.some((f) => f.status === "modified") ?? false;
      if (hash === entry.sha256) {
        results.push({ name, ref: entry.ref, state: "unchanged" });
        continue;
      }
      const currentPath = paths.find((p) => existsSync(join(root, p)));
      const current = currentPath ? unstamp(readFileSync(join(root, currentPath), "utf8")) : "";
      const diff = lineDiff(current, fetched);
      if (!opts.apply) {
        results.push({ name, ref: entry.ref, state: "available", diff });
        continue;
      }
      if (localEdits && !opts.force) {
        results.push({ name, ref: entry.ref, state: "blocked-local-edits", diff });
        continue;
      }
      const targets = (Object.keys(TARGET_DIRS) as Target[]).filter((t) => paths.some((p) => p.startsWith(TARGET_DIRS[t] + "/")));
      const plan = planInstall(root, entry.ref, skill, targets.length ? targets : ["claude"]);
      applyInstall(root, { ...plan, conflicts: [] });
      results.push({ name, ref: entry.ref, state: "updated", diff });
    } catch (err) {
      results.push({ name, ref: entry.ref, state: "error", error: (err as Error).message });
    }
  }
  return results;
}
