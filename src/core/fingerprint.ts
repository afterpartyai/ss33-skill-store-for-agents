/**
 * Project fingerprint: a short, privacy-safe summary of the stack, sent with searches so the
 * store can rank skills that fit (npm vs bun, Postgres 16 vs 15, ...).
 *
 * Reads only manifests and lockfile *names* — never source code, never dependency trees.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

export interface Fingerprint {
  languages: string[];
  packageManagers: string[];
  /** Notable frameworks/tools with the version range the manifest declares. */
  tools: Record<string, string>;
  /** Service images from compose files, e.g. "postgres:16". */
  services: string[];
  ci: string[];
  summary: string;
}

const NODE_TOOLS = [
  "typescript", "react", "next", "vue", "nuxt", "svelte", "@sveltejs/kit", "angular", "@angular/core",
  "express", "fastify", "@nestjs/core", "hono", "vite", "webpack", "vitest", "jest", "mocha", "playwright",
  "@playwright/test", "cypress", "eslint", "biome", "@biomejs/biome", "prettier", "tailwindcss", "prisma",
  "drizzle-orm", "typeorm", "pg", "mongoose", "redis", "graphql", "electron", "react-native", "expo",
];
const PY_TOOLS = [
  "django", "flask", "fastapi", "pytest", "pandas", "numpy", "polars", "sqlalchemy", "pydantic", "celery",
  "torch", "tensorflow", "scikit-learn", "langchain", "anthropic", "openai", "alembic", "ruff", "mypy",
];
const MAX_SUMMARY = 320;

function read(dir: string, file: string): string | undefined {
  try {
    return readFileSync(join(dir, file), "utf8");
  } catch {
    return undefined;
  }
}

function has(dir: string, file: string): boolean {
  return existsSync(join(dir, file));
}

export function fingerprint(dir: string): Fingerprint {
  const languages = new Set<string>();
  const packageManagers = new Set<string>();
  const tools: Record<string, string> = {};
  const services = new Set<string>();
  const ci = new Set<string>();

  // Node / TypeScript
  const pkgRaw = read(dir, "package.json");
  if (pkgRaw) {
    languages.add("javascript");
    try {
      const pkg = JSON.parse(pkgRaw) as Record<string, unknown>;
      const deps = { ...(pkg.dependencies as object), ...(pkg.devDependencies as object) } as Record<string, string>;
      for (const name of NODE_TOOLS) if (deps[name]) tools[name.replace(/^@[^/]+\//, (s) => s)] = deps[name];
      if (deps.typescript) languages.add("typescript");
      const pm = typeof pkg.packageManager === "string" ? pkg.packageManager.split("@")[0] : undefined;
      if (pm) packageManagers.add(pm);
      const engines = pkg.engines as Record<string, string> | undefined;
      if (engines?.node) tools.node = engines.node;
    } catch {
      /* malformed package.json: languages still recorded */
    }
  }
  if (has(dir, "package-lock.json")) packageManagers.add("npm");
  if (has(dir, "pnpm-lock.yaml")) packageManagers.add("pnpm");
  if (has(dir, "yarn.lock")) packageManagers.add("yarn");
  if (has(dir, "bun.lockb") || has(dir, "bun.lock")) packageManagers.add("bun");
  if (has(dir, "deno.json") || has(dir, "deno.jsonc")) {
    languages.add("typescript");
    packageManagers.add("deno");
  }

  // Python
  const pyproject = read(dir, "pyproject.toml");
  const requirements = read(dir, "requirements.txt");
  if (pyproject || requirements || has(dir, "setup.py")) {
    languages.add("python");
    const text = `${pyproject ?? ""}\n${requirements ?? ""}`.toLowerCase();
    // PEP 621 `requires-python`, or Poetry's `python = "^3.11"` under [tool.poetry.dependencies].
    const py = pyproject?.match(/requires-python\s*=\s*["']([^"']+)["']/) ?? pyproject?.match(/^python\s*=\s*["']([^"']+)["']/m);
    if (py?.[1]) tools.python = py[1];
    for (const name of PY_TOOLS) {
      const n = name.replace(/[-]/g, "[-_]");
      // Poetry table entry: `fastapi = "^0.110"` or `fastapi = { version = "^0.110", … }`.
      const poetry = text.match(new RegExp(`^${n}\\s*=\\s*(?:\\{[^}]*version\\s*=\\s*)?["']([^"']+)["']`, "m"));
      if (poetry) {
        tools[name] = poetry[1]!;
        continue;
      }
      // PEP 508 string: "fastapi>=0.110", "pydantic[email]~=2.0", or a bare name.
      const m = text.match(new RegExp(`(?:^|["'\\s])${n}\\s*(?:\\[[^\\]]*\\])?\\s*([<>=~!^]=?[^"'\\s,;=]*)?(?=["'\\s,;]|$)`, "m"));
      if (m) tools[name] = m[1] ?? "*";
    }
    if (has(dir, "uv.lock")) packageManagers.add("uv");
    if (has(dir, "poetry.lock") || /\[tool\.poetry\]/.test(pyproject ?? "")) packageManagers.add("poetry");
    if (requirements && !packageManagers.has("uv") && !packageManagers.has("poetry")) packageManagers.add("pip");
  }

  // Other ecosystems: language + toolchain version only.
  const gomod = read(dir, "go.mod");
  if (gomod) {
    languages.add("go");
    const v = gomod.match(/^go\s+([\d.]+)/m)?.[1];
    if (v) tools.go = v;
  }
  const cargo = read(dir, "Cargo.toml");
  if (cargo) {
    languages.add("rust");
    const ed = cargo.match(/edition\s*=\s*"(\d+)"/)?.[1];
    if (ed) tools["rust-edition"] = ed;
  }
  const gemfile = read(dir, "Gemfile");
  if (gemfile) {
    languages.add("ruby");
    if (/gem\s+["']rails["']/.test(gemfile)) tools.rails = gemfile.match(/gem\s+["']rails["']\s*,\s*["']([^"']+)/)?.[1] ?? "*";
  }
  if (has(dir, "pom.xml")) (languages.add("java"), packageManagers.add("maven"));
  if (has(dir, "build.gradle") || has(dir, "build.gradle.kts")) (languages.add("jvm"), packageManagers.add("gradle"));
  if (has(dir, "composer.json")) (languages.add("php"), packageManagers.add("composer"));

  // Services and CI
  for (const f of ["docker-compose.yml", "docker-compose.yaml", "compose.yml", "compose.yaml"]) {
    const text = read(dir, f);
    if (!text) continue;
    for (const m of text.matchAll(/^\s*image:\s*["']?([\w./-]+(?::[\w.-]+)?)/gm)) if (m[1]) services.add(m[1].split("/").pop()!);
  }
  if (has(dir, "Dockerfile")) tools.docker = "Dockerfile";
  if (has(dir, ".github/workflows")) {
    try {
      if (readdirSync(join(dir, ".github/workflows")).some((f) => /\.ya?ml$/.test(f))) ci.add("github-actions");
    } catch {
      /* unreadable dir */
    }
  }
  if (has(dir, ".gitlab-ci.yml")) ci.add("gitlab-ci");

  const fp = {
    languages: [...languages],
    packageManagers: [...packageManagers],
    tools,
    services: [...services],
    ci: [...ci],
  };
  return { ...fp, summary: summarize(fp) };
}

export function summarize(fp: Omit<Fingerprint, "summary">): string {
  const parts: string[] = [];
  if (fp.languages.length) parts.push(`languages: ${fp.languages.join(", ")}`);
  if (fp.packageManagers.length) parts.push(`package manager: ${fp.packageManagers.join(", ")}`);
  const tools = Object.entries(fp.tools).map(([k, v]) => (v === "*" ? k : `${k} ${v}`));
  if (tools.length) parts.push(`uses: ${tools.join(", ")}`);
  if (fp.services.length) parts.push(`services: ${fp.services.join(", ")}`);
  if (fp.ci.length) parts.push(`ci: ${fp.ci.join(", ")}`);
  const s = parts.join("; ");
  return s.length > MAX_SUMMARY ? s.slice(0, MAX_SUMMARY - 1) + "…" : s;
}
