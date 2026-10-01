#!/usr/bin/env node
// subagent: expose niminal subagents as model tools and a slash command.
//
// Each run starts "niminal --mode json --no-session" in a fresh read-only
// session and returns the subagent's final report with its token usage. Agents
// are built-in scout, general, planner, reviewer, and oracle, plus any *.md files
// under a subagents/
// folder in the global or project .niminal and .agents roots. Project agents
// need a trusted workspace. One call carries a task, a parallel batch, or a
// sequential chain, and a run can go to the background and be collected later
// with subagent_result. Runs show in a Subagents panel above the composer, and
// calls beyond the concurrency limit wait for a slot instead of failing.
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, extname, join } from 'node:path'
import { randomBytes } from 'node:crypto'
import readline from 'node:readline'

const send = (message) => process.stdout.write(JSON.stringify(message) + '\n')

let workspace = process.cwd()

// Subagents are read-only: the tool allowlist is the whole safety boundary, and
// a headless subagent has no permission prompt. Agent files may only name these
// built-ins; anything else is dropped with a warning.
const READ_ONLY_TOOLS = ['read', 'grep', 'glob', 'ls', 'skill']
const READ_ONLY_LIST = READ_ONLY_TOOLS.join(',')

// niminal accepts these levels for --thinking, so an agent file that names
// anything else is dropped rather than sent on to fail the run.
const THINKING_LEVELS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']
const MAX_CHAIN_STEPS = 8
// A report is kept for the life of this process, which outlives session
// changes, so the map is capped.
const MAX_RESULTS = 32
const MAX_OUTPUT_LINES = 2000
const MAX_OUTPUT_BYTES = 50 * 1024

const BUILTIN_AGENTS = {
  scout: {
    description: 'fast codebase recon for handoff: files, entry points, risks',
    tools: 'read,grep,glob,ls',
    model: '',
    prompt:
      'You are a read-only scout subagent. Explore the codebase for the task: prefer grep and ' +
      'glob over reading whole files, follow imports, then return compressed findings with ' +
      'relevant paths, symbols, data flow, and risks for the parent agent.'
  },
  general: {
    description: 'multi-step research across files and skills',
    tools: 'read,grep,glob,ls,skill',
    model: '',
    prompt:
      'You are a read-only research subagent. Work through the task in steps and check every ' +
      'claim against the code before reporting.'
  },
  planner: {
    description: 'read-only implementation plan with acceptance criteria',
    tools: 'read,grep,glob,ls',
    model: '',
    prompt:
      'You are a read-only planner subagent. Read the code and constraints, then produce a ' +
      'numbered implementation plan with acceptance criteria and concrete verification steps. ' +
      'Do not edit files or assume changes are already made.'
  },
  reviewer: {
    description: 'code review for correctness, tests, and simplicity',
    tools: 'read,grep,glob,ls',
    model: '',
    prompt:
      'You are a read-only reviewer subagent. Review the code or change described in the task ' +
      'for bugs, missing tests, edge cases, and unnecessary complexity. Cite file paths and lines.'
  },
  oracle: {
    description: 'second opinion: challenge assumptions before acting',
    tools: 'read,grep,glob,ls',
    model: '',
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

// Without this, a subagent that finishes with "done" reports nothing useful.
const REPORT_CONTRACT =
  ' Finish with a report for the parent agent: a short summary, then your findings with ' +
  'file paths and line numbers, then anything you could not determine. You cannot change ' +
  'files, so never describe edits you did not make.'

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
  const requested = (fields.tools || READ_ONLY_LIST)
    .split(',').map((tool) => tool.trim()).filter(Boolean)
  const tools = requested.filter((tool) => READ_ONLY_TOOLS.includes(tool))
  const dropped = requested.filter((tool) => !READ_ONLY_TOOLS.includes(tool))
  if (dropped.length) {
    process.stderr.write(
      `subagent: agent "${name}" ignores non-read-only tools: ${dropped.join(', ')}\n`)
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
    tools: tools.length ? tools.join(',') : READ_ONLY_LIST,
    model: fields.model || '',
    thinking,
    maxSteps,
    prompt: body
  }
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
    description: 'Run a read-only subagent on a task and print its report'
  }],
  tools: [{
    name: 'subagent',
    description:
      'Run isolated read-only subagents in their own niminal sessions and return their final ' +
      'reports. A subagent cannot see this conversation, so every task must be complete and ' +
      'self-contained, including file paths and what to report. One call carries a single ' +
      '"task", a parallel "tasks" batch, or a sequential "chain" where "{previous}" stands for ' +
      'the prior step\'s report. Subagents can read files but cannot edit them or run commands, ' +
      'and they cannot start further subagents, so delegate investigation, not changes. Use ' +
      'them for broad investigation, parallel research, and double-checking; do trivial lookups ' +
      `yourself. Calls made in the same step run in parallel, up to ${registeredMaxConcurrent} at a time, ` +
      'and further calls wait for a slot. Set run_in_background to start work and carry on: the ' +
      'response carries an id, and subagent_result collects the report when it is ready. ' +
      `Known agents at register time: ${registeredAgentGuide}. Custom agents from disk work ` +
      'immediately; run /reload to refresh this list in the tool description.',
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
              label: { type: 'string', description: 'Short name shown in the panel.' }
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
              label: { type: 'string', description: 'Short name shown in the panel.' }
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
            `. All agents are read-only. Defaults to ${registeredDefaultAgent}.`
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
    capabilities: ['read']
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
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n)
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

  const args = ['--mode', 'json', '--no-session', '--tools', run.agent.tools,
    '--append-system-prompt', run.agent.prompt + REPORT_CONTRACT]
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
      { cwd: workspace, stdio: ['pipe', 'pipe', 'pipe'] })
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
    const text = [failure ? `subagent ${failure}` : '', report, notes]
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
  timeoutSeconds }) {
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
  return {
    job: {
      callId,
      index,
      task,
      label: makeLabel(source.label ?? input.label, task),
      agent,
      model: resolveModel(name, agent),
      thinking: agent.thinking || runtime.defaultThinking,
      maxSteps: agent.maxSteps || runtime.defaultMaxSteps,
      timeoutSeconds
    }
  }
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
    send({
      type: 'response',
      id: message.id,
      content: [{ type: 'text', text: joinedReports(parts) }],
      is_error: parts.every((part) => part.result.isError)
    })
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
      content: [{ type: 'text', text: backgroundText(started) }]
    })
    return
  }
  const parts = await collect(started)
  send({
    type: 'response',
    id: message.id,
    content: [{ type: 'text', text: joinedReports(parts) }],
    is_error: parts.every((part) => part.result.isError)
  })
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
  send({
    type: 'response',
    id: message.id,
    content: [{ type: 'text', text: done ? parentFacingText(entry.result.text) : pendingText(entry) }],
    is_error: done && entry.result.isError
  })
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
    maxSteps: agent.maxSteps || runtime.defaultMaxSteps,
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
