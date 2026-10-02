#!/usr/bin/env node
// subagent: expose niminal subagents as model tools and a slash command.
//
// Each run starts "niminal --mode json --no-session" in a fresh session and
// returns the subagent's final report with its token usage. Agents are built-in
// scout, general, planner, reviewer, and oracle (read-only by default), plus
// any *.md files under a subagents/ folder in the global or project .niminal
// and .agents roots. Agent frontmatter `tools:` is authoritative: omit it for
// the read-only default, or list write tools (edit, write, bash) for workers.
// Read-only extras such as git stay opt-in without marking a writer. Project
// agents need a trusted workspace. One call carries a task, a parallel batch,
// or a sequential chain. Optional cwd / worktree isolate
// writers. A run can go to the background and be collected later with
// subagent_result. Runs show in a Subagents panel above the composer, and calls
// beyond the concurrency limit wait for a slot instead of failing.
import { spawn, execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, writeSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, extname, isAbsolute, join, resolve } from 'node:path'
import { randomBytes } from 'node:crypto'
import readline from 'node:readline'

const send = (message) => {
  writeSync(1, JSON.stringify(message) + '\n')
}

let workspace = process.cwd()

// Parent session footer usage is parent-only; roll up child tokens here for the extension status line.
// Cleared on session_start (/new, /resume) because the extension process outlives sessions.
const SUBAGENT_STATUS_KEY = 'subagents'
let cumulativeSubagentInput = 0
let cumulativeSubagentOutput = 0

// Default when an agent omits tools:. Built-ins stay on this list. Read-only
// extras such as git belong here; write tools are opt-in via frontmatter and
// nested subagent tools are never allowed.
const DEFAULT_TOOLS = ['read', 'grep', 'glob', 'ls', 'git', 'skill']
const DEFAULT_TOOLS_LIST = DEFAULT_TOOLS.join(',')
const WRITE_TOOLS = new Set(['edit', 'write', 'bash'])
const BLOCKED_TOOLS = new Set(['subagent', 'subagent_result'])

// niminal accepts these levels for --thinking, so an agent file that names
// anything else is dropped rather than sent on to fail the run.
const THINKING_LEVELS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']
const MAX_CHAIN_STEPS = 8
// Read-only agents stop after this many tool-loop steps. Scout cost grows with the
// square of the step count, so this is the wallet guard for a model that ignores its
// budget, not the point where a normal run stops.
const READ_ONLY_MAX_STEPS = 30
// A report is kept for the life of this process, which outlives session
// changes, so the map is capped.
const MAX_RESULTS = 32
const MAX_OUTPUT_LINES = 2000
const MAX_OUTPUT_BYTES = 50 * 1024
const PSTACK_MODELS_PATH = join(homedir(), '.niminal', 'pstack', 'models.json')

const BUILTIN_AGENTS = {
  scout: {
    description: 'fast codebase recon for handoff: files, entry points, risks',
    tools: 'read,grep,glob,ls,git',
    model: '',
    maxSteps: READ_ONLY_MAX_STEPS,
    prompt:
      'You are a read-only scout subagent. Explore the codebase for the task: prefer grep and ' +
      'glob over reading whole files, follow imports, then return compressed findings with ' +
      'relevant paths, symbols, data flow, and risks for the parent agent.'
  },
  general: {
    description: 'multi-step research across files and skills',
    tools: 'read,grep,glob,ls,git,skill',
    model: '',
    maxSteps: READ_ONLY_MAX_STEPS,
    prompt:
      'You are a read-only research subagent. Work through the task in steps and check every ' +
      'claim against the code before reporting.'
  },
  planner: {
    description: 'read-only implementation plan with acceptance criteria',
    tools: 'read,grep,glob,ls,git',
    model: '',
    maxSteps: READ_ONLY_MAX_STEPS,
    prompt:
      'You are a read-only planner subagent. Read the code and constraints, then produce a ' +
      'numbered implementation plan with acceptance criteria and concrete verification steps. ' +
      'Do not edit files or assume changes are already made.'
  },
  reviewer: {
    description: 'code review for correctness, tests, and simplicity',
    tools: 'read,grep,glob,ls,git',
    model: '',
    maxSteps: READ_ONLY_MAX_STEPS,
    prompt:
      'You are a read-only reviewer subagent. Review the code or change described in the task ' +
      'for bugs, missing tests, edge cases, and unnecessary complexity. Cite file paths and lines.'
  },
  oracle: {
    description: 'second opinion: challenge assumptions before acting',
    tools: 'read,grep,glob,ls,git',
    model: '',
    maxSteps: READ_ONLY_MAX_STEPS,
    prompt:
      'You are a read-only oracle subagent. Challenge assumptions, surface what the parent might ' +
      'be missing, and give a direct second opinion. Do not edit files or prescribe changes you ' +
      'cannot verify in the repo.'
  }
}

const DEFAULT_CONFIG = {
  max_concurrent: 4,
  timeout_seconds: 1800,
  default_agent: 'general',
  default_model: '',
  thinking: '',
  max_steps: 0
}

function childContract(toolsCsv) {
  const tools = String(toolsCsv || '').split(',').map((tool) => tool.trim()).filter(Boolean)
  const writable = tools.some((tool) => WRITE_TOOLS.has(tool))
  if (writable) {
    return ' Finish with a report for the parent agent: a short summary, then your findings ' +
      'with file paths and line numbers, then anything you could not determine. Describe only ' +
      'edits and commands you actually ran. You cannot start further subagents.'
  }
  return ' Work inside a budget. Answer the task with the smallest set of reads that gets ' +
    'there: grep and glob before read, and read only files that matched or sit on the call ' +
    'chain. Prefer a few broad searches over many narrow ones, and batch independent lookups ' +
    'into the same turn instead of spending a turn on one narrow read. Stay inside the angle ' +
    'the task names instead of inventorying the repository. Unless the task states a different ' +
    'budget, spend at most 12 tool calls and keep one turn in reserve for the report. When the ' +
    'budget runs out, stop and report what you found with the gaps named, because a named gap ' +
    'beats another read. Finish with a report for the parent agent: a short summary, then your ' +
    'findings with file paths and line numbers, then anything you could not determine. You ' +
    'cannot change files, so never describe edits you did not make. You cannot start further ' +
    'subagents.'
}

// A step cap is a ceiling, so the tighter of the agent's own cap and the configured
// default wins. 0 means unset.
function stepCap(agent, fallback) {
  const caps = [agent.maxSteps, fallback].filter((value) => value > 0)
  return caps.length ? Math.min(...caps) : 0
}

function toolsAreWritable(toolsCsv) {
  return String(toolsCsv || '').split(',').map((tool) => tool.trim())
    .some((tool) => WRITE_TOOLS.has(tool))
}

function parseToolsList(raw) {
  const requested = String(raw || DEFAULT_TOOLS_LIST)
    .split(',').map((tool) => tool.trim()).filter(Boolean)
  const tools = []
  const dropped = []
  for (const tool of requested) {
    if (!/^[a-z][a-z0-9_]*$/.test(tool) || BLOCKED_TOOLS.has(tool)) {
      dropped.push(tool)
      continue
    }
    tools.push(tool)
  }
  return {
    tools: tools.length ? tools.join(',') : DEFAULT_TOOLS_LIST,
    dropped
  }
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

// Split YAML frontmatter from the prompt body. Values are plain strings, so a
// full YAML parser would be more machinery than this needs.
function parseFrontmatter(text) {
  const lines = text.split(/\r?\n/)
  if (lines[0]?.trim() !== '---') {
    return { fields: {}, body: text.trim() }
  }
  const fields = {}
  let index = 1
  for (; index < lines.length; index++) {
    if (lines[index].trim() === '---') {
      index++
      break
    }
    const match = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(lines[index])
    if (match) {
      fields[match[1].toLowerCase()] = match[2].trim().replace(/^["']|["']$/g, '')
    }
  }
  return { fields, body: lines.slice(index).join('\n').trim() }
}

function thinkingLevel(value) {
  const level = String(value ?? '').trim().toLowerCase()
  return THINKING_LEVELS.includes(level) ? level : ''
}

function agentFromFile(file) {
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return null
  }
  const { fields, body } = parseFrontmatter(text)
  const name = (fields.name || basename(file, extname(file))).trim().toLowerCase()
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(name) || !body) {
    process.stderr.write(`subagent: skipping ${file}: need a valid name and a prompt body\n`)
    return null
  }
  const { tools, dropped } = parseToolsList(fields.tools || DEFAULT_TOOLS_LIST)
  if (dropped.length) {
    process.stderr.write(
      `subagent: agent "${name}" ignores invalid or nested-subagent tools: ${dropped.join(', ')}\n`)
  }
  const thinking = thinkingLevel(fields.thinking)
  if (fields.thinking && !thinking) {
    process.stderr.write(
      `subagent: agent "${name}" ignores thinking level "${fields.thinking}" ` +
      `(use ${THINKING_LEVELS.join(', ')})\n`)
  }
  const steps = Number.parseInt(fields.max_steps ?? '', 10)
  const maxSteps = Number.isInteger(steps) && steps > 0 ? steps : 0
  if (fields.max_steps && !maxSteps) {
    process.stderr.write(`subagent: agent "${name}" ignores max_steps "${fields.max_steps}"\n`)
  }
  return {
    name,
    // The model picks an agent by its description, so an agent file without one
    // falls back to the prompt's first line rather than hiding its purpose.
    description: fields.description || body.split('\n')[0].trim().replace(/\.$/, '').slice(0, 120),
    tools,
    model: fields.model || '',
    thinking,
    maxSteps,
    prompt: body
  }
}

function resolveRoleModel(role, index = 0) {
  const name = String(role ?? '').trim()
  if (!name) return ''
  const config = readJson(PSTACK_MODELS_PATH)
  const value = config?.roles?.[name]
  if (value === undefined || value === null) return ''
  const list = Array.isArray(value) ? value : [value]
  if (!list.length) return ''
  const pick = String(list[index % list.length] ?? '').trim()
  if (!pick || pick === 'inherit-parent' || pick === 'auto') return ''
  return pick
}

function slugify(value) {
  const slug = String(value || 'worker')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
  return slug || `worker-${randomBytes(3).toString('hex')}`
}

function ensureWorktree(label) {
  const slug = slugify(label)
  const root = join(workspace, '.niminal', 'worktrees')
  mkdirSync(root, { recursive: true })
  const path = join(root, slug)
  if (existsSync(path)) {
    return path
  }
  try {
    execFileSync('git', ['rev-parse', '--is-inside-work-tree'], {
      cwd: workspace,
      stdio: ['ignore', 'pipe', 'pipe']
    })
  } catch {
    throw new Error(`worktree requires a git repository at ${workspace}`)
  }
  const branch = `niminal-wt/${slug}`
  try {
    execFileSync('git', ['worktree', 'add', '-B', branch, path, 'HEAD'], {
      cwd: workspace,
      stdio: ['ignore', 'pipe', 'pipe']
    })
  } catch (err) {
    const detail = String(err.stderr || err.message || err).trim()
    throw new Error(`git worktree add failed for ${path}: ${detail}`)
  }
  return path
}

function resolveRunCwd({ cwd, worktree, label }) {
  if (cwd) {
    const resolved = isAbsolute(cwd) ? cwd : resolve(workspace, cwd)
    if (!existsSync(resolved)) {
      throw new Error(`subagent cwd does not exist: ${resolved}`)
    }
    return resolved
  }
  if (worktree) {
    return ensureWorktree(label)
  }
  return workspace
}

// Global files first, then project files, and the portable .agents layout
// before .niminal, so the last file read wins.
const GLOBAL_ROOTS = [join(homedir(), '.agents'), join(homedir(), '.niminal')]

function positiveNumber(value, fallback) {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? number : fallback
}

let runtime = {
  agents: {},
  trusted: true,
  defaultAgent: 'general',
  maxConcurrent: 4,
  defaultTimeoutSeconds: 1800,
  defaultModel: '',
  defaultModels: {},
  models: {},
  defaultThinking: '',
  defaultMaxSteps: 0
}

let warnedUntrustedProject = false

function resourceRoots() {
  const trusted = process.env.NIMINAL_TRUSTED !== '0'
  const roots = trusted
    ? [...GLOBAL_ROOTS, join(workspace, '.agents'), join(workspace, '.niminal')]
    : GLOBAL_ROOTS
  return { trusted, roots }
}

// What niminal started this extension with. session_start and
// session_settings_changed keep both current: the process keeps running across
// a session, provider, or reasoning-level change, so these events are how
// provider-keyed models and the default thinking level follow it.
let sessionProviderName = String(process.env.NIMINAL_PROVIDER ?? '').trim().toLowerCase()
let sessionThinkingLevel = String(process.env.NIMINAL_REASONING_LEVEL ?? '')

function sessionProvider() {
  return sessionProviderName
}

function providerModelLookup(map, provider) {
  if (!map || typeof map !== 'object' || Array.isArray(map) || !provider) {
    return ''
  }
  if (typeof map[provider] === 'string') {
    return map[provider].trim()
  }
  for (const [key, value] of Object.entries(map)) {
    if (key.toLowerCase() === provider && typeof value === 'string') {
      return value.trim()
    }
  }
  return ''
}

function mergeSubagentsConfig(target, source) {
  if (!source || typeof source !== 'object') {
    return
  }
  for (const [key, value] of Object.entries(source)) {
    if (key === 'models' && value && typeof value === 'object' && !Array.isArray(value)) {
      target.models ??= {}
      for (const [agent, providers] of Object.entries(value)) {
        const agentKey = String(agent).trim().toLowerCase()
        if (!providers || typeof providers !== 'object' || Array.isArray(providers)) {
          continue
        }
        target.models[agentKey] = { ...(target.models[agentKey] || {}) }
        for (const [prov, model] of Object.entries(providers)) {
          if (typeof model !== 'string') {
            continue
          }
          const id = model.trim()
          if (!id) {
            continue
          }
          target.models[agentKey][String(prov).trim().toLowerCase()] = id
        }
      }
      continue
    }
    if (key === 'default_models' && value && typeof value === 'object' && !Array.isArray(value)) {
      target.default_models ??= {}
      for (const [prov, model] of Object.entries(value)) {
        if (typeof model !== 'string') {
          continue
        }
        const id = model.trim()
        if (!id) {
          continue
        }
        target.default_models[String(prov).trim().toLowerCase()] = id
      }
      continue
    }
    target[key] = value
  }
}

function resolveModel(agentName, agent) {
  const name = String(agentName ?? '').trim().toLowerCase()
  const provider = sessionProvider()
  const fromMap = providerModelLookup(runtime.models[name], provider)
  if (fromMap) {
    return fromMap
  }
  const fromAgent = String(agent?.model ?? '').trim()
  if (fromAgent) {
    return fromAgent
  }
  const fromDefaultMap = providerModelLookup(runtime.defaultModels, provider)
  if (fromDefaultMap) {
    return fromDefaultMap
  }
  return runtime.defaultModel
}

function loadAgentsFromDisk(roots) {
  const agents = Object.fromEntries(
    Object.entries(BUILTIN_AGENTS).map(([name, agent]) => [name, { ...agent }]))
  for (const dir of roots.map((root) => join(root, 'subagents'))) {
    let entries = []
    try {
      entries = readdirSync(dir)
    } catch {
      continue
    }
    for (const entry of entries.sort()) {
      if (!entry.endsWith('.md')) continue
      const parsed = agentFromFile(join(dir, entry))
      if (!parsed) continue
      const { name, ...agent } = parsed
      agents[name] = agent
    }
  }
  return agents
}

function refreshRuntime() {
  const { trusted, roots } = resourceRoots()
  const config = { ...DEFAULT_CONFIG, models: {}, default_models: {} }
  for (const root of roots) {
    mergeSubagentsConfig(config, readJson(join(root, 'subagents.json')))
  }
  if (!trusted && !warnedUntrustedProject) {
    warnedUntrustedProject = true
    process.stderr.write(
      'subagent: ignoring project agents and subagents.json: project not trusted ' +
      '(use /trust on or --approve)\n')
  }
  const agents = loadAgentsFromDisk(roots)
  const defaultAgent = agents[config.default_agent] ? config.default_agent : 'general'
  const defaultThinking = thinkingLevel(config.thinking) || thinkingLevel(sessionThinkingLevel)
  runtime = {
    agents,
    trusted,
    defaultAgent,
    maxConcurrent: positiveNumber(process.env.SUBAGENT_MAX_CONCURRENT,
      positiveNumber(config.max_concurrent, 4)),
    defaultTimeoutSeconds: positiveNumber(process.env.SUBAGENT_TIMEOUT_SECONDS,
      positiveNumber(config.timeout_seconds, 1800)),
    defaultModel: process.env.SUBAGENT_DEFAULT_MODEL || config.default_model || '',
    defaultModels: config.default_models || {},
    models: config.models || {},
    defaultThinking,
    defaultMaxSteps: positiveNumber(config.max_steps, 0)
  }
}

function agentList(agents) {
  return Object.entries(agents)
    .map(([name, agent]) => `${name} (${agent.tools}): ${agent.description}`).join('; ')
}

function truncateForParent(text) {
  if (!text) return text
  const bytes = Buffer.byteLength(text, 'utf8')
  const lines = text.split('\n')
  if (lines.length <= MAX_OUTPUT_LINES && bytes <= MAX_OUTPUT_BYTES) {
    return text
  }
  let truncated = text
  if (lines.length > MAX_OUTPUT_LINES) {
    truncated = lines.slice(-MAX_OUTPUT_LINES).join('\n')
  }
  while (Buffer.byteLength(truncated, 'utf8') > MAX_OUTPUT_BYTES) {
    const index = truncated.indexOf('\n')
    if (index === -1) {
      truncated = truncated.slice(-MAX_OUTPUT_BYTES)
      break
    }
    truncated = truncated.slice(index + 1)
  }
  const spillPath = join(tmpdir(), `niminal-subagent-${randomBytes(8).toString('hex')}.txt`)
  writeFileSync(spillPath, text, { mode: 0o600 })
  return `${truncated}\n\nFull output saved to: ${spillPath}`
}

function parentFacingText(text) {
  return truncateForParent(text)
}

refreshRuntime()
const registeredAgentGuide = agentList(runtime.agents)
const registeredMaxConcurrent = runtime.maxConcurrent
const registeredDefaultAgent = runtime.defaultAgent
const registeredDefaultTimeout = runtime.defaultTimeoutSeconds

send({
  type: 'register',
  commands: [{
    name: 'subagent',
    description: 'Run a subagent on a task and print its report'
  }],
  tools: [{
    name: 'subagent',
    description:
      'Run isolated subagents in their own niminal sessions and return their final reports. ' +
      'A subagent cannot see this conversation, so every task must be complete and ' +
      'self-contained, including file paths and what to report. One call carries a single ' +
      '"task", a parallel "tasks" batch, or a sequential "chain" where "{previous}" stands for ' +
      'the prior step\'s report. Agent frontmatter tools: control the child allowlist: omit for ' +
      'read-only defaults, or include edit/write/git/bash for writers. Optional cwd or ' +
      'worktree:true isolates a writer under .niminal/worktrees/<slug>. Optional role resolves ' +
      'a model from ~/.niminal/pstack/models.json (inherit-parent keeps the session model). ' +
      'Children cannot start further subagents. Use them for investigation, parallel research, ' +
      'and delegated implementation in a worktree; do trivial lookups yourself. Calls made in ' +
      `the same step run in parallel, up to ${registeredMaxConcurrent} at a time, and further ` +
      'calls wait for a slot. Set run_in_background to start work and carry on: the response ' +
      'carries an id, and subagent_result collects the report when it is ready. Known agents at ' +
      `register time: ${registeredAgentGuide}. Custom agents from disk work immediately; run ` +
      '/reload to refresh this list in the tool description.',
    input_schema: {
      type: 'object',
      properties: {
        task: {
          type: 'string',
          description: 'Complete, self-contained instructions for one subagent. Use with "agent".'
        },
        tasks: {
          type: 'array',
          description: 'Parallel batch: start every item at once and wait for all of them.',
          items: {
            type: 'object',
            properties: {
              task: { type: 'string', description: 'Complete, self-contained instructions.' },
              agent: {
                type: 'string',
                description: `Agent name. Defaults to ${registeredDefaultAgent}.`
              },
              label: { type: 'string', description: 'Short name shown in the panel.' },
              model: { type: 'string', description: 'Model id override for this item.' },
              role: {
                type: 'string',
                description: 'pstack role name from ~/.niminal/pstack/models.json.'
              },
              cwd: { type: 'string', description: 'Working directory for this child.' },
              worktree: {
                type: 'boolean',
                description: 'Create or reuse .niminal/worktrees/<label> and run there.'
              }
            },
            required: ['task']
          }
        },
        chain: {
          type: 'array',
          description: 'Sequential steps: each step runs after the last one reports. In a step ' +
            'task, "{previous}" is replaced by the previous step\'s report.',
          items: {
            type: 'object',
            properties: {
              task: { type: 'string', description: 'Instructions, optionally using {previous}.' },
              agent: {
                type: 'string',
                description: `Agent name. Defaults to ${registeredDefaultAgent}.`
              },
              label: { type: 'string', description: 'Short name shown in the panel.' },
              model: { type: 'string', description: 'Model id override for this step.' },
              role: {
                type: 'string',
                description: 'pstack role name from ~/.niminal/pstack/models.json.'
              },
              cwd: { type: 'string', description: 'Working directory for this child.' },
              worktree: {
                type: 'boolean',
                description: 'Create or reuse .niminal/worktrees/<label> and run there.'
              }
            },
            required: ['task']
          }
        },
        label: {
          type: 'string',
          description: 'Short name shown in the Subagents panel, e.g. "parser-investigation".'
        },
        agent: {
          type: 'string',
          description: registeredAgentGuide +
            `. Defaults to ${registeredDefaultAgent}.`
        },
        model: {
          type: 'string',
          description: 'Model id override for every job in this call unless an item sets its own.'
        },
        role: {
          type: 'string',
          description: 'pstack role from ~/.niminal/pstack/models.json for model selection.'
        },
        cwd: {
          type: 'string',
          description: 'Working directory for every job unless an item sets its own.'
        },
        worktree: {
          type: 'boolean',
          description: 'Create or reuse a git worktree under .niminal/worktrees for each job ' +
            'that does not set cwd.'
        },
        run_in_background: {
          type: 'boolean',
          description: 'Return as soon as the run starts instead of waiting for its report. ' +
            'Collect it with subagent_result, which also works in a later turn. Chains always ' +
            'run in the foreground.'
        },
        timeout_seconds: {
          type: 'number',
          description: `Kill the subagent after this many seconds. Defaults to ${registeredDefaultTimeout}.`
        }
      },
      required: []
    },
    capabilities: ['read', 'write', 'shell']
  }, {
    name: 'subagent_result',
    description:
      'Collect the report of a subagent started with run_in_background, or check on one that ' +
      'is still running. Returns the same report the subagent would have returned inline, and ' +
      'what it is doing right now while it runs.',
    input_schema: {
      type: 'object',
      properties: {
        id: {
          type: 'number',
          description: 'Id from the subagent response, e.g. 3 for "id 3".'
        },
        wait_seconds: {
          type: 'number',
          description: 'Wait this long for the run to finish before reporting. Defaults to 0, ' +
            'which reports the current status without waiting.'
        }
      },
      required: ['id']
    },
    capabilities: ['read']
  }],
  events: ['session_start', 'session_settings_changed']
})

// Every run, keyed by its number, so a background report can be collected long
// after the run left the panel. Queued runs wait for a concurrency slot, FIFO.
const runs = new Map()
const results = new Map()
const queue = []
let nextNumber = 0
// niminal redraws the panel from what it holds, so no state lives here beyond
// the last update.
let ticker = null
// The single in-flight cleanup, shared by every stop trigger below.
let stopping = null
// A subagent gets this long to exit after SIGTERM before it is SIGKILLed. It
// has to fit in the 3s niminal waits before it kills this extension, otherwise
// niminal ends the extension mid-cleanup and the subagent survives it.
const stopGraceMs = 1500
const WIDGET_KEY = 'subagents'

function activeCount() {
  let count = 0
  for (const run of runs.values()) {
    if (run.phase === 'active') count++
  }
  return count
}

// A child that ignores SIGTERM has to be killed outright. It stays in this
// extension's process group, so niminal kills it too if it ends this extension
// before the escalation below runs.
function stopChild(run) {
  const child = run.child
  if (!child || child.pid === undefined) {
    return Promise.resolve()
  }
  return new Promise((resolve) => {
    const finish = () => {
      try { child.kill('SIGKILL') } catch {}
      resolve()
    }
    if (child.exitCode !== null || child.signalCode !== null) return finish()
    // Let niminal close its extensions and cancel active tools itself.
    child.kill('SIGTERM')
    const escalate = setTimeout(finish, stopGraceMs)
    child.once('close', () => { clearTimeout(escalate); finish() })
  })
}

function stopAll() {
  // niminal sends "shutdown" and closes stdin, so both triggers race. Reusing
  // one pass keeps the kill alive instead of exiting before it finishes.
  if (stopping) return stopping
  stopping = Promise.resolve()
  for (const run of [...runs.values()]) {
    if (run.phase === 'queued') cancelRun(run, 'host')
  }
  stopping = Promise.all(
    [...runs.values()].filter((run) => run.phase === 'active').map(stopChild))
  return stopping
}

function formatTokens(n) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n)
}

function clearSubagentUsageStatus() {
  cumulativeSubagentInput = 0
  cumulativeSubagentOutput = 0
  send({
    type: 'update',
    status: { key: SUBAGENT_STATUS_KEY, segments: [] }
  })
}

function subagentStatusPayload() {
  if (cumulativeSubagentInput === 0 && cumulativeSubagentOutput === 0) return null
  return {
    key: SUBAGENT_STATUS_KEY,
    segments: [{
      text: `subagents ↑${formatTokens(cumulativeSubagentInput)} ↓${formatTokens(cumulativeSubagentOutput)}`,
      style: 'muted'
    }]
  }
}

function pushSubagentUsageStatus() {
  const status = subagentStatusPayload()
  if (!status) return
  send({ type: 'update', status })
}

function recordSubagentUsage(run) {
  const inp = run.inputTokens || 0
  const out = run.outputTokens || 0
  if (inp === 0 && out === 0) return
  cumulativeSubagentInput += inp
  cumulativeSubagentOutput += out
  pushSubagentUsageStatus()
}

function withSubagentStatus(response) {
  const status = subagentStatusPayload()
  return status ? { ...response, status } : response
}

function formatDuration(seconds) {
  return seconds < 120
    ? `${seconds} second${seconds === 1 ? '' : 's'}`
    : `${Math.round(seconds / 60)} minutes`
}

function clip(value, max) {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value
}

function describeCall(event) {
  const input = event.input || {}
  const detail = input.path || input.command || input.pattern || ''
  return detail ? `: ${String(detail).slice(0, 80)}` : ''
}

function elapsed(run) {
  const seconds = Math.max(0, Math.round(((run.endedAt || Date.now()) - run.startedAt) / 1000))
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m${seconds % 60}s`
}

function runRow(run) {
  const tokens = run.inputTokens ? ` · ${formatTokens(run.inputTokens)} in` : ''
  // A run that never started (queued, or cancelled while queued) has no elapsed time.
  const timing = run.startedAt ? ` · ${elapsed(run)}` : ''
  const state = run.phase === 'done' ? 'done' : run.phase === 'queued' ? 'pending' : 'active'
  return { text: `#${run.number} ${run.label} · ${run.activity}${timing}${tokens}`, state }
}

// Subagent progress goes in a panel above the composer, never in the transcript:
// every update replaces the panel, while a transcript line would stay forever
// and push the conversation out of the visible window. niminal keeps no more
// than 8 widget actions and 32 list items, so these caps keep the panel valid.
function refresh() {
  const all = [...runs.values()]
  const live = all.filter((run) => run.phase !== 'done')
  if (live.length === 0) {
    if (all.length) runs.clear()
    if (ticker) {
      clearInterval(ticker)
      ticker = null
      // An empty title, content, and actions removes the widget.
      send({ type: 'update', widget: { key: WIDGET_KEY, title: '', content: [], actions: [] } })
    }
    return
  }
  if (!ticker) {
    // Elapsed times keep moving even when a subagent works without emitting.
    ticker = setInterval(refresh, 1000)
    ticker.unref?.()
  }
  const finished = all.filter((run) => run.phase === 'done')
  const active = live.filter((run) => run.phase === 'active').length
  const queued = live.length - active
  const tokens = all.reduce((total, run) => total + run.inputTokens, 0)
  const summary = []
  if (finished.length) {
    summary.push(`${finished.length} done`)
  }
  if (tokens) {
    summary.push(`${formatTokens(tokens)} in`)
  }
  const actions = live.length > 1 ? [{ id: 'stop_all', label: 'Stop all' }] : []
  for (const run of live.slice(0, Math.max(0, 8 - actions.length))) {
    actions.push({ id: `stop:${run.id}`, label: `Stop ${clip(run.label, 24)}` })
  }
  send({
    type: 'update',
    widget: {
      key: WIDGET_KEY,
      title: `Subagents · ${active} running${queued ? ` · ${queued} queued` : ''}`,
      content: [
        ...(summary.length ? [{ type: 'text', style: 'muted', text: summary.join(' · ') }] : []),
        { type: 'list', items: [...live, ...finished].slice(-20).map(runRow) }
      ],
      actions
    }
  })
}

function cancelReason(run) {
  if (run.stopReason === 'user') return 'stopped by the user'
  if (run.stopReason === 'timeout') {
    return `killed after ${formatDuration(run.timeoutSeconds)} without finishing`
  }
  return 'stopped before finishing'
}

// A subagent stops because the user asked, because niminal cancelled the tool
// call, or because it ran out of time. The first reason wins.
function cancelRun(run, reason) {
  if (run.phase === 'done' || run.stopReason) return
  run.stopReason = reason
  run.activity = reason === 'user' ? 'stopped by you' : reason === 'timeout' ? 'timed out' : 'stopped'
  if (run.phase === 'queued') {
    finishRun(run, { text: `subagent ${cancelReason(run)}`, isError: true })
    return
  }
  stopChild(run)
  refresh()
}

function finishRun(run, result) {
  if (run.settled) return
  run.settled = true
  run.phase = 'done'
  run.endedAt = Date.now()
  run.child = null
  recordSubagentUsage(run)
  const entry = results.get(run.number)
  if (entry) {
    entry.status = 'done'
    entry.result = result
    entry.endedAt = run.endedAt
    // Resolves entry.done for the caller and for subagent_result.
    entry.settle()
  }
  forgetOldResults()
  // A free slot may let a queued run start, so pump before redrawing.
  pump()
  refresh()
}

// Finished reports stay collectable by id, so only the oldest ones fall out.
function forgetOldResults() {
  for (const [number, entry] of results) {
    if (results.size <= MAX_RESULTS) return
    if (entry.status === 'done') results.delete(number)
  }
}

function pump() {
  if (stopping) return
  while (queue.length && activeCount() < runtime.maxConcurrent) {
    const run = runs.get(queue.shift())
    if (run && run.phase === 'queued') startRun(run)
  }
}

function resolveNiminalBin() {
  if (process.env.NIMINAL_BIN) {
    return process.env.NIMINAL_BIN
  }
  const local = `${workspace}/niminal/build/niminal`
  return existsSync(local) ? local : 'niminal'
}

function startRun(run) {
  run.phase = 'active'
  run.startedAt = Date.now()
  run.activity = 'starting'
  refresh()

  let cwd
  try {
    cwd = resolveRunCwd({
      cwd: run.cwd,
      worktree: run.worktree,
      label: run.worktreeName || run.label
    })
  } catch (err) {
    finishRun(run, { text: `subagent could not prepare cwd: ${err.message}`, isError: true })
    return
  }
  run.resolvedCwd = cwd
  if (cwd !== workspace) {
    run.activity = `starting in ${cwd}`
    refresh()
  }

  const args = ['--mode', 'json', '--no-session', '--tools', run.agent.tools,
    '--append-system-prompt', run.agent.prompt + childContract(run.agent.tools)]
  if (sessionProvider()) {
    args.push('--provider', sessionProvider())
  }
  if (run.model) {
    args.push('--model', run.model)
  }
  if (run.thinking) {
    args.push('--thinking', run.thinking)
  }
  if (run.maxSteps) {
    args.push('--max-steps', String(run.maxSteps))
  }
  if (runtime.trusted) {
    // niminal reports this workspace as trusted, so its skills and instructions
    // load here too instead of being skipped for the lack of a prompt.
    args.push('--approve')
  }

  let child
  try {
    // Not detached: the subagent shares this extension's process group, so a
    // niminal that gives up on this extension still kills the subagent.
    child = spawn(resolveNiminalBin(), args,
      { cwd, stdio: ['pipe', 'pipe', 'pipe'] })
  } catch (err) {
    finishRun(run, { text: `subagent could not start niminal: ${err.message}`, isError: true })
    return
  }
  run.child = child
  child.stdin.end(run.task)

  let steps = 0
  let finalText = ''
  let lastError = ''
  let stderrTail = ''

  const timer = setTimeout(() => cancelRun(run, 'timeout'), run.timeoutSeconds * 1000)
  timer.unref?.()

  readline.createInterface({ input: child.stdout }).on('line', (line) => {
    if (!line.trim()) return
    let event
    try { event = JSON.parse(line) } catch { return }
    if (event.type === 'tool_call') {
      run.activity = `${event.tool_name}${describeCall(event)}`
      refresh()
    } else if (event.type === 'step_end' && event.usage) {
      steps++
      run.inputTokens += event.usage.input_tokens || 0
      run.outputTokens += event.usage.output_tokens || 0
      run.activity = 'thinking'
      refresh()
    } else if (event.type === 'message' && event.role === 'assistant' && event.final) {
      finalText = event.content || ''
    } else if (event.type === 'error') {
      lastError = event.message || 'subagent error'
    }
  })

  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk) => {
    stderrTail = (stderrTail + chunk).slice(-2000)
  })

  child.on('error', (err) => {
    clearTimeout(timer)
    finishRun(run, { text: `subagent could not run niminal: ${err.message}`, isError: true })
  })

  child.on('close', (code) => {
    clearTimeout(timer)
    const usage = `subagent usage: ${formatTokens(run.inputTokens)} in / ` +
      `${formatTokens(run.outputTokens)} out over ${steps} step${steps === 1 ? '' : 's'}`
    // Whatever the subagent managed to say before it stopped is still worth
    // returning, so the parent can see how far it got.
    const report = finalText ? `${finalText}\n\n---\n${usage}` : ''
    const notes = stderrNotes(stderrTail)
    let failure = ''
    if (run.stopReason) {
      failure = cancelReason(run)
    } else if (lastError) {
      failure = `failed: ${lastError}`
    } else if (code) {
      failure = `exited with status ${code}`
    } else if (code === null) {
      failure = 'was killed'
    } else if (!finalText) {
      failure = 'finished without a report'
    }
    const text = [failure ? `subagent ${failure}` : '',
      run.resolvedCwd && run.resolvedCwd !== workspace
        ? `subagent cwd: ${run.resolvedCwd}`
        : '',
      report, notes]
      .filter(Boolean).join('\n\n')
    // "report" is the bare answer, which is what a chain step gets through
    // "{previous}" so it does not pay for the usage footer as well.
    finishRun(run, { text, isError: Boolean(failure), report: finalText })
  })
}

// niminal and the provider write warnings to stderr, and a run that exits clean
// still leaves them there, so they come back as a short note instead of vanishing.
function stderrNotes(tail) {
  const lines = tail.split('\n').map((line) => line.trim()).filter(Boolean)
  return lines.length ? `subagent notes:\n${lines.slice(-3).map((line) => clip(line, 200)).join('\n')}` : ''
}

// Queue a run and start it as soon as a concurrency slot is free. The caller
// awaits entry.done and reads entry.result, which also works long after the run
// left the panel, so a background report can be collected in a later turn.
function runSubagent({ callId, index, task, label, agent, model, thinking, maxSteps,
  timeoutSeconds, cwd, worktree, worktreeName }) {
  const number = ++nextNumber
  // One call can carry several runs, and the panel action ids have to tell them
  // apart while host cancellation still names the call.
  const id = `${callId}:${index}`
  const entry = { number, label, status: 'running', result: null, endedAt: 0 }
  entry.done = new Promise((resolve) => { entry.settle = resolve })
  const run = {
    id,
    callId,
    number,
    task,
    label,
    agent,
    model,
    thinking,
    maxSteps,
    timeoutSeconds,
    cwd: cwd || '',
    worktree: Boolean(worktree),
    worktreeName: worktreeName || label,
    resolvedCwd: '',
    phase: 'queued',
    child: null,
    startedAt: 0,
    endedAt: 0,
    activity: 'queued',
    inputTokens: 0,
    outputTokens: 0,
    stopReason: '',
    settled: false
  }
  runs.set(id, run)
  results.set(number, entry)
  queue.push(id)
  refresh()
  pump()
  return { run, entry }
}

function makeLabel(raw, task) {
  // A label with newlines would forge lines in the panel.
  return (String(raw ?? '').trim() || task).replace(/\s+/g, ' ').slice(0, 40)
}

function usageText() {
  return 'Usage: /subagent [agent] <task>. Agents: ' + agentList(runtime.agents) +
    `. Defaults to ${runtime.defaultAgent}.`
}

function sendError(id, text) {
  send({ type: 'response', id, is_error: true, content: [{ type: 'text', text }] })
}

function agentNames() {
  return Object.keys(runtime.agents).join(', ')
}

// A bare task, a parallel batch, or a sequential chain. Only one of the three,
// so a mixed call fails loudly instead of dropping half the work.
function planJobs(input) {
  if (Array.isArray(input.chain)) {
    if (!input.chain.length || input.chain.length > MAX_CHAIN_STEPS) {
      return { error: `subagent "chain" needs 1 to ${MAX_CHAIN_STEPS} steps.` }
    }
    if (input.run_in_background) {
      return { error: 'a subagent chain runs in the foreground because each step needs the ' +
        'one before it. Start single tasks in the background instead.' }
    }
    return { items: input.chain, chain: true }
  }
  if (Array.isArray(input.tasks)) {
    if (!input.tasks.length) {
      return { error: 'subagent "tasks" needs at least one task.' }
    }
    return { items: input.tasks, chain: false }
  }
  if (String(input.task ?? '').trim()) {
    return { items: [{ task: input.task }], chain: false }
  }
  return { error: 'subagent needs "task", "tasks", or "chain".' }
}

function timeoutFor(value) {
  if (value === undefined) return runtime.defaultTimeoutSeconds
  const seconds = Number(value)
  return Number.isFinite(seconds) && seconds > 0 ? seconds : 0
}

// Items may be a plain task string or an object, so accept both.
function itemObject(item) {
  if (typeof item === 'string') return { task: item }
  return item && typeof item === 'object' ? item : {}
}

// Turn one plan item into a run. The item wins over the call-level fields, so a
// batch can mix agents while sharing the timeout.
function jobFor(item, input, callId, index, timeoutSeconds) {
  const source = itemObject(item)
  const { name, agent } = agentFor(source.agent ?? input.agent)
  if (!agent) {
    return { error: `subagent "agent" must be one of: ${agentNames()}.` }
  }
  const task = String(source.task ?? '').trim()
  if (!task) {
    return { error: 'every subagent needs a non-empty "task".' }
  }
  const label = makeLabel(source.label ?? input.label, task)
  const role = source.role ?? input.role
  const model = String(source.model ?? input.model ?? '').trim() ||
    resolveRoleModel(role, index) ||
    resolveModel(name, agent)
  const cwd = String(source.cwd ?? input.cwd ?? '').trim()
  const worktree = Boolean(source.worktree ?? input.worktree)
  return {
    job: {
      callId,
      index,
      task,
      label,
      agent,
      model,
      thinking: agent.thinking || runtime.defaultThinking,
      maxSteps: stepCap(agent, runtime.defaultMaxSteps),
      timeoutSeconds,
      cwd,
      worktree,
      worktreeName: label
    }
  }
}

function sharedWritableCwdWarning(jobs) {
  const writers = jobs.filter((job) => toolsAreWritable(job.agent.tools))
  if (writers.length < 2) return ''
  const keys = writers.map((job) => {
    if (job.cwd) return `cwd:${resolve(isAbsolute(job.cwd) ? job.cwd : join(workspace, job.cwd))}`
    if (job.worktree) return `worktree:${slugify(job.worktreeName || job.label)}`
    return `workspace:${workspace}`
  })
  const counts = new Map()
  for (const key of keys) counts.set(key, (counts.get(key) || 0) + 1)
  const collisions = [...counts.entries()].filter(([, count]) => count > 1).map(([key]) => key)
  if (!collisions.length) return ''
  return 'warning: multiple write-capable subagents share a working tree (' +
    `${collisions.join(', ')}). Prefer distinct worktree:true or cwd values so writers ` +
    'do not collide.\n\n'
}

function agentFor(raw) {
  const name = String(raw ?? '').trim().toLowerCase() || runtime.defaultAgent
  return { name, agent: runtime.agents[name] }
}

function backgroundText(started) {
  const parts = started.map(({ entry }) =>
    `id ${entry.number} (${entry.label}) is running in the background`)
  return `${parts.join('; ')}.\n\nKeep working, then call subagent_result with that id to ` +
    'collect the report. Results stay available by id for the rest of this niminal run.'
}

async function collect(started) {
  return Promise.all(started.map(async ({ entry }) => {
    await entry.done
    return { label: entry.label, result: entry.result }
  }))
}

// Each step waits for the one before it, so a step can build on the report it
// gets through "{previous}".
async function runChain(items, input, callId, timeoutSeconds) {
  const parts = []
  let previous = ''
  for (const [index, item] of items.entries()) {
    const task = String(itemObject(item).task ?? '').replaceAll('{previous}', previous)
    const made = jobFor({ ...itemObject(item), task }, input, callId, index, timeoutSeconds)
    if (made.error) {
      parts.push({ label: `step ${index + 1}`, result: { text: made.error, isError: true } })
      break
    }
    const { entry } = runSubagent(made.job)
    await entry.done
    previous = entry.result.report || entry.result.text
    parts.push({ label: made.job.label, result: entry.result })
    if (entry.result.isError) break
  }
  return parts
}

function joinedReports(parts) {
  const failed = parts.filter((part) => part.result.isError).length
  const heading = parts.length > 1
    ? `${parts.length} subagents finished${failed ? `, ${failed} failed` : ''}.\n\n`
    : ''
  const body = parts.map((part, index) => {
    const title = parts.length > 1
      ? `## ${index + 1}. ${part.label}${part.result.isError ? ' (failed)' : ''}\n`
      : ''
    return `${title}${parentFacingText(part.result.text)}`
  }).join('\n\n')
  return heading + body
}

async function handleTool(message) {
  refreshRuntime()
  const input = message.arguments || {}
  const timeoutSeconds = timeoutFor(input.timeout_seconds)
  if (!timeoutSeconds) {
    sendError(message.id, 'subagent "timeout_seconds" must be a positive number.')
    return
  }
  const plan = planJobs(input)
  if (plan.error) {
    sendError(message.id, plan.error)
    return
  }
  if (plan.chain) {
    const parts = await runChain(plan.items, input, message.id, timeoutSeconds)
    send(withSubagentStatus({
      type: 'response',
      id: message.id,
      content: [{ type: 'text', text: joinedReports(parts) }],
      is_error: parts.every((part) => part.result.isError)
    }))
    return
  }
  const jobs = []
  for (const [index, item] of plan.items.entries()) {
    const made = jobFor(item, input, message.id, index, timeoutSeconds)
    if (made.error) {
      sendError(message.id, made.error)
      return
    }
    jobs.push(made.job)
  }
  const started = jobs.map(runSubagent)
  if (input.run_in_background) {
    send({
      type: 'response',
      id: message.id,
      content: [{ type: 'text', text: sharedWritableCwdWarning(jobs) + backgroundText(started) }]
    })
    return
  }
  const parts = await collect(started)
  send(withSubagentStatus({
    type: 'response',
    id: message.id,
    content: [{ type: 'text', text: sharedWritableCwdWarning(jobs) + joinedReports(parts) }],
    is_error: parts.every((part) => part.result.isError)
  }))
}

const sleep = (ms) => new Promise((resolve) => {
  const timer = setTimeout(resolve, ms)
  timer.unref?.()
})

function runsForCall(callId) {
  return [...runs.values()].filter((run) => run.callId === callId)
}

function liveRun(number) {
  for (const run of runs.values()) {
    if (run.number === number) return run
  }
  return null
}

// A run that is still going reports what it is doing instead of a report, so a
// poll is informative even when the answer is "not yet".
function pendingText(entry) {
  const run = liveRun(entry.number)
  const where = run?.phase === 'queued'
    ? 'is queued behind the concurrency limit'
    : `is running: ${run?.activity ?? 'working'}${run?.startedAt ? ` · ${elapsed(run)}` : ''}`
  return `subagent ${entry.number} (${entry.label}) ${where}. Call subagent_result again, ` +
    'or pass wait_seconds, to collect its report.'
}

async function handleResult(message) {
  refreshRuntime()
  const input = message.arguments || {}
  const entry = results.get(Number(input.id))
  if (!entry) {
    const known = [...results.keys()].map((number) => `id ${number}`).join(', ')
    sendError(message.id,
      `no subagent with id ${input.id}. ` +
      (known ? `Known runs: ${known}.` : 'No subagent has run yet.'))
    return
  }
  const waitSeconds = Math.min(Math.max(Number(input.wait_seconds) || 0, 0), 300)
  if (entry.status !== 'done' && waitSeconds > 0) {
    await Promise.race([entry.done, sleep(waitSeconds * 1000)])
  }
  const done = entry.status === 'done'
  const response = {
    type: 'response',
    id: message.id,
    content: [{ type: 'text', text: done ? parentFacingText(entry.result.text) : pendingText(entry) }],
    is_error: done && entry.result.isError
  }
  send(done ? withSubagentStatus(response) : response)
}

// /subagent [agent] <task> runs one subagent and prints its report. A leading
// word only counts as an agent when it names one, so a normal task is safe.
async function handleCommand(message) {
  refreshRuntime()
  const args = String(message.arguments ?? '').trim()
  const first = args.split(/\s+/)[0].toLowerCase()
  const name = runtime.agents[first] ? first : runtime.defaultAgent
  const task = runtime.agents[first] ? args.slice(first.length).trim() : args
  if (!task) {
    send({ type: 'response', id: message.id, message: usageText() })
    return
  }
  const agent = runtime.agents[name]
  const { entry } = runSubagent({
    callId: `command:${message.id}`,
    index: 0,
    task,
    label: makeLabel('', task),
    agent,
    model: resolveModel(name, agent),
    thinking: agent.thinking || runtime.defaultThinking,
    maxSteps: stepCap(agent, runtime.defaultMaxSteps),
    timeoutSeconds: runtime.defaultTimeoutSeconds
  })
  await entry.done
  send({ type: 'response', id: message.id, message: parentFacingText(entry.result.text) })
}

const input = readline.createInterface({ input: process.stdin })
input.on('line', (line) => {
  if (!line.trim()) return
  let message
  try { message = JSON.parse(line) } catch { return }
  if (message.type === 'initialize') {
    workspace = message.workspace || workspace
    refreshRuntime()
  } else if (message.type === 'event' &&
             (message.event === 'session_start' ||
              message.event === 'session_settings_changed')) {
    // niminal never restarts this process for a session or settings change, so
    // these two events are how the active provider and reasoning level follow.
    const payload = message.payload ?? {}
    if (payload.provider) {
      sessionProviderName = String(payload.provider).trim().toLowerCase()
    }
    if (payload.thinking !== undefined) {
      sessionThinkingLevel = String(payload.thinking)
    }
    refreshRuntime()
    if (message.event === 'session_start') {
      // Totals are per parent session, not per extension process lifetime.
      clearSubagentUsageStatus()
    }
    send({ type: 'response', id: message.id })
  } else if (message.type === 'tool' && message.name === 'subagent') {
    handleTool(message).catch((err) => {
      sendError(message.id, `subagent failed: ${err.message}`)
    })
  } else if (message.type === 'tool' && message.name === 'subagent_result') {
    handleResult(message).catch((err) => {
      sendError(message.id, `subagent_result failed: ${err.message}`)
    })
  } else if (message.type === 'command' && message.name === 'subagent') {
    handleCommand(message).catch((err) => {
      send({ type: 'response', id: message.id, message: `subagent failed: ${err.message}` })
    })
  } else if (message.type === 'cancel') {
    // niminal has given up on this tool call and drops the response, so stop the
    // child instead of letting it work and bill until its timeout. One call can
    // have started several runs, so every one of them stops.
    for (const run of runsForCall(message.id)) {
      cancelRun(run, 'host')
    }
  } else if (message.type === 'ui_action' && message.widget === WIDGET_KEY) {
    // Stop buttons in the panel. The tool result still reaches the model, so it
    // learns that the run was stopped rather than finished.
    if (message.action === 'stop_all') {
      for (const run of [...runs.values()]) {
        cancelRun(run, 'user')
      }
    } else if (String(message.action ?? '').startsWith('stop:')) {
      const run = runs.get(message.action.slice('stop:'.length))
      if (run) {
        cancelRun(run, 'user')
      }
    }
  } else if (message.type === 'shutdown') {
    stopAll().then(() => process.exit(0))
  } else if (message.id !== undefined) {
    send({ type: 'response', id: message.id })
  }
})
// niminal may exit without asking (killed, or the terminal is gone).
input.on('close', () => {
  stopAll().then(() => process.exit(0))
})
