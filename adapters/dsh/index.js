/**
 * ss33 Skill Store plugin for DeepSeek Harness (DSH). A Cordis plugin, mounted by this package's cordis.patch.yml.
 * It holds no ss33 logic: everything goes through the bundled CLI (lib/ss33.cjs), as in the other harness plugins.
 *
 * - Registers the user-only skills in skills/ (/ss33-search, /ss33-add, …). DSH doesn't namespace plugin skills.
 * - Gives shell commands DSH_SS33_PLUGIN_ROOT, so the skills can find scripts/ss33.
 * - Prompt matching (off unless the user turned it on): on a turn's first step, pipes the user's text to
 *   `ss33 hook dsh pre-step` and appends its hint as a notice message (the user sees the one-line summary).
 *
 * No imports from DSH packages: a profile's node_modules holds only the packages it installed, not DSH's own.
 */
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('.', import.meta.url))
const HOOK_TIMEOUT_MS = 5000
const TRUE = ['1', 'true', 'yes', 'on']

export const name = 'ss33'
export const inject = ['skills']

/** Each skills/<name>/SKILL.md, split into its frontmatter fields and body. */
function readSkills() {
  const dir = join(root, 'skills')
  return readdirSync(dir).sort().map((folder) => {
    const md = readFileSync(join(dir, folder, 'SKILL.md'), 'utf8')
    const [, front, body] = md.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/)
    const field = (key) => front.match(new RegExp(`^${key}:\\s*(.+)$`, 'm'))?.[1].trim()
    return { folder: join(dir, folder), name: field('name'), description: field('description'), userOnly: field('disable-model-invocation') === 'true', body: body.trim() }
  })
}

/** Prompt matching on? The CLI's precedence: SS33_MATCH, then match.enabled in ss33's config.json, then off.
 * Checked here so a turn with matching off (the default) starts no process. A config file that can't be read
 * leaves the decision to the CLI. Keep in step with loadConfig in src/core/config.ts. */
export function matchingOn(env = process.env) {
  if (env.SS33_MATCH) return TRUE.includes(env.SS33_MATCH.toLowerCase())
  const dir = env.SS33_CONFIG_DIR || join(env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'ss33')
  let text
  try {
    text = readFileSync(join(dir, 'config.json'), 'utf8')
  } catch (err) {
    return err?.code !== 'ENOENT'
  }
  try {
    return JSON.parse(text)?.match?.enabled === true
  } catch {
    return true
  }
}

/** The text of the user's own messages in this step: not other plugins' injections, not skill bodies. */
export function userText(messages) {
  return messages
    .filter((m) => m?.source?.kind === 'user')
    .flatMap((m) => (Array.isArray(m.content) ? m.content : []))
    .filter((part) => part?.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('\n')
    .trim()
}

/** Runs `ss33 hook dsh pre-step` with DSH's own Node.js. Resolves to the parsed output, or undefined. */
export function runHook(input, { signal, env = process.env, node = process.execPath } = {}) {
  return new Promise((resolve) => {
    let out = ''
    let child
    try {
      child = spawn(node, [join(root, 'lib', 'ss33.cjs'), 'hook', 'dsh', 'pre-step'], {
        // Under DSH Desktop process.execPath is Electron, which runs a script as Node.js only with this set.
        env: { ...env, ELECTRON_RUN_AS_NODE: '1' },
        stdio: ['pipe', 'pipe', 'ignore'],
        timeout: HOOK_TIMEOUT_MS,
        windowsHide: true,
        ...(signal ? { signal } : {}),
      })
    } catch {
      return resolve(undefined)
    }
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => { out += chunk })
    child.on('error', () => resolve(undefined))
    child.on('close', () => {
      try {
        const parsed = JSON.parse(out)
        resolve(typeof parsed?.context === 'string' && parsed.context ? parsed : undefined)
      } catch {
        resolve(undefined)
      }
    })
    child.stdin.on('error', () => {})
    child.stdin.end(JSON.stringify(input))
  })
}

/** A user-role context message, as dsh-llm's createUserMessage builds it. `notice` shows the user its summary. */
export function hintMessage({ context, notice }) {
  return Object.freeze({
    id: randomUUID(),
    role: 'user',
    content: Object.freeze([Object.freeze({ type: 'text', text: context })]),
    source: Object.freeze({ kind: 'ss33', form: 'notice', summary: notice || 'ss33: a Skill Store skill may fit this task' }),
  })
}

export function apply(ctx) {
  const log = ctx.logger?.('ss33')

  for (const skill of readSkills()) {
    try {
      ctx.skills.register({
        name: skill.name,
        description: skill.description,
        content: skill.body,
        source: 'runtime',
        invocation: { modelInvocable: !skill.userOnly, userInvocable: true },
        resourceBase: { kind: 'directory', path: skill.folder },
      })
    } catch (err) {
      log?.warn?.(`could not register skill ${skill.name}: ${err?.message ?? err}`)
    }
  }

  ctx.inject(['shellEnv'], (scoped) => {
    scoped.shellEnv.register({
      name: 'ss33',
      variables: { DSH_SS33_PLUGIN_ROOT: { description: 'Folder of the ss33 Skill Store plugin; its CLI is scripts/ss33 there.' } },
      resolve: () => ({ DSH_SS33_PLUGIN_ROOT: root }),
    })
  })

  // The session's current folder, when the working-directory service is mounted (it follows folder changes).
  let workingDirectory
  ctx.inject(['workingDirectory'], (scoped) => {
    scoped.effect(() => {
      workingDirectory = scoped.workingDirectory
      return () => { workingDirectory = undefined }
    }, 'ss33:working-directory')
  })

  ctx.inject(['agents'], (scoped) => {
    scoped.on('agent/pre-step', async (payload, next) => {
      const decision = await next()
      try {
        const { agent, step, signal } = payload
        if (decision.kind === 'reject' || signal?.aborted || step !== 1) return decision
        if (agent?.session?.header?.origin === 'subagent' || !matchingOn()) return decision
        const prompt = userText(decision.messages ?? [])
        if (!prompt) return decision
        const cwd = (await workingDirectory?.ensure(agent, signal).catch(() => undefined)) ?? agent?.session?.header?.cwd ?? ''
        const hint = await runHook({ session_id: String(agent?.session?.id ?? agent?.id ?? ''), cwd, prompt }, { signal })
        if (!hint || signal?.aborted) return decision
        return { ...decision, messages: [...decision.messages, hintMessage(hint)] }
      } catch (err) {
        log?.debug?.(`prompt matching skipped: ${err?.message ?? err}`)
        return decision
      }
    })
  })
}
