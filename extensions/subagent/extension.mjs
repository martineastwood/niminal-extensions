#!/usr/bin/env node
// subagent: expose niminal subagents as a model tool and a slash command.
//
// Each run starts "niminal --mode json --no-session" in a fresh read-only
// session and returns the subagent's final report with its token usage. Agents
// are the built-in explore and general, plus any *.md files under a subagents/
// folder in the global or project .niminal and .agents roots. Runs show in a
// Subagents panel above the composer, and calls beyond the concurrency limit
// wait for a slot instead of failing.
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, extname, join } from 'node:path'
import readline from 'node:readline'

const send = (message) => process.stdout.write(JSON.stringify(message) + '\n')

let workspace = process.cwd()

// Subagents are read-only: the tool allowlist is the whole safety boundary, and
// a headless subagent has no permission prompt. Agent files may only name these
// built-ins; anything else is dropped with a warning.
const READ_ONLY_TOOLS = ['read', 'grep', 'glob', 'ls', 'skill']
const READ_ONLY_LIST = READ_ONLY_TOOLS.join(',')

const BUILTIN_AGENTS = {
  explore: {
    description: 'find where code lives, fastest for search',
    tools: 'read,grep,glob,ls',
    model: '',
    prompt:
      'You are a read-only code search subagent. Locate the code the task asks about: ' +
      'prefer grep and glob over reading whole files, follow imports until you can name the ' +
      'files and functions that matter, then report.'
  },
  general: {
    description: 'multi-step research across files and skills',
    tools: 'read,grep,glob,ls,skill',
    model: '',
    prompt:
      'You are a read-only research subagent. Work through the task in steps and check every ' +
      'claim against the code before reporting.'
  }
}

const DEFAULT_CONFIG = {
  max_concurrent: 4,
  timeout_seconds: 1800,
  default_agent: 'general',
  default_model: ''
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
  return {
    name,
    description: fields.description || `custom agent from ${basename(file)}`,
    tools: tools.length ? tools.join(',') : READ_ONLY_LIST,
    model: fields.model || '',
    prompt: body
  }
}

// Global files first, then project files, and the portable .agents layout
// before .niminal, so the last file read wins. niminal orders its own resources
// the same way. It runs extensions in the workspace, so process.cwd() is the
// workspace.
const RESOURCE_ROOTS = [
  join(homedir(), '.agents'),
  join(homedir(), '.niminal'),
  join(workspace, '.agents'),
  join(workspace, '.niminal')
]
const agentDirs = RESOURCE_ROOTS.map((root) => join(root, 'subagents'))

const config = { ...DEFAULT_CONFIG }
for (const root of RESOURCE_ROOTS) {
  Object.assign(config, readJson(join(root, 'subagents.json')) || {})
}

const AGENTS = Object.fromEntries(
  Object.entries(BUILTIN_AGENTS).map(([name, agent]) => [name, { ...agent }]))
for (const dir of agentDirs) {
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
    AGENTS[name] = agent
  }
}

function positiveNumber(value, fallback) {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? number : fallback
}

const DEFAULT_AGENT = AGENTS[config.default_agent] ? config.default_agent : 'general'
const maxConcurrent = positiveNumber(process.env.SUBAGENT_MAX_CONCURRENT,
  positiveNumber(config.max_concurrent, 4))
const defaultTimeoutSeconds = positiveNumber(process.env.SUBAGENT_TIMEOUT_SECONDS,
  positiveNumber(config.timeout_seconds, 1800))
const defaultModel = process.env.SUBAGENT_DEFAULT_MODEL || config.default_model || ''

send({
  type: 'register',
  commands: [{
    name: 'subagent',
    description: 'Run a read-only subagent on a task and print its report'
  }],
  tools: [{
    name: 'subagent',
    description:
      'Run an isolated read-only subagent in its own niminal session and return its final ' +
      'report. The subagent cannot see this conversation, so give it a complete, ' +
      'self-contained task including file paths and what to report. It can read files but ' +
      'cannot edit them or run commands, so delegate investigation, not changes. Use it for ' +
      'broad investigation, parallel research, and double-checking; do trivial lookups ' +
      'yourself. Calls made in the same step run in parallel, up to the concurrency limit.',
    input_schema: {
      type: 'object',
      properties: {
        task: {
          type: 'string',
          description: 'Complete, self-contained instructions for the subagent.'
        },
        label: {
          type: 'string',
          description: 'Short name shown in the Subagents panel, e.g. "parser-investigation".'
        },
        agent: {
          type: 'string',
          enum: Object.keys(AGENTS),
          description: Object.entries(AGENTS)
            .map(([name, agent]) => `${name}: ${agent.description}`)
            .join('; ') + `. Defaults to ${DEFAULT_AGENT}.`
        },
        timeout_seconds: {
          type: 'number',
          description: `Kill the subagent after this many seconds. Defaults to ${defaultTimeoutSeconds}.`
        }
      },
      required: ['task']
    },
    capabilities: ['read']
  }]
})

// Runs by tool/command id, kept until the panel closes so a fan-out shows what
// already finished. Queued ids wait for a concurrency slot, FIFO.
const runs = new Map()
const queue = []
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
  stopping ??= Promise.all(
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
  return { text: `${run.label} · ${run.activity}${timing}${tokens}`, state }
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
  // A free slot may let a queued run start, so pump before redrawing.
  pump()
  refresh()
  run.resolve(result)
}

function pump() {
  while (queue.length && activeCount() < maxConcurrent) {
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
  if (run.model) {
    args.push('--model', run.model)
  }
  args.push(run.task)

  let child
  try {
    // Not detached: the subagent shares this extension's process group, so a
    // niminal that gives up on this extension still kills the subagent.
    child = spawn(resolveNiminalBin(), args,
      { cwd: workspace, stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (err) {
    finishRun(run, { text: `subagent could not start niminal: ${err.message}`, isError: true })
    return
  }
  run.child = child

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
    const lastLine = stderrTail.trim().split('\n').pop() || ''
    let failure = ''
    if (run.stopReason) {
      failure = cancelReason(run)
    } else if (lastError) {
      failure = `failed: ${lastError}`
    } else if (code) {
      failure = `exited with status ${code}${lastLine ? `: ${lastLine}` : ''}`
    } else if (code === null) {
      failure = 'was killed'
    } else if (!finalText) {
      failure = 'finished without a report'
    }
    finishRun(run, {
      text: failure ? `subagent ${failure}${report ? `\n\n${report}` : ''}` : report,
      isError: Boolean(failure)
    })
  })
}

// Queue a run and start it as soon as a concurrency slot is free.
function runSubagent({ id, task, label, agent, model, timeoutSeconds }) {
  return new Promise((resolve) => {
    runs.set(id, {
      id,
      task,
      label,
      agent,
      model,
      timeoutSeconds,
      phase: 'queued',
      child: null,
      startedAt: 0,
      endedAt: 0,
      activity: 'queued',
      inputTokens: 0,
      outputTokens: 0,
      stopReason: '',
      settled: false,
      resolve
    })
    queue.push(id)
    refresh()
    pump()
  })
}

function makeLabel(raw, task) {
  // A label with newlines would forge lines in the panel.
  return (String(raw ?? '').trim() || task).replace(/\s+/g, ' ').slice(0, 40)
}

function usageText() {
  return 'Usage: /subagent [agent] <task>. Agents: ' +
    Object.entries(AGENTS).map(([name, agent]) => `${name}: ${agent.description}`).join('; ') +
    `. Defaults to ${DEFAULT_AGENT}.`
}

function sendError(id, text) {
  send({ type: 'response', id, is_error: true, content: [{ type: 'text', text }] })
}

async function handleTool(message) {
  const input = message.arguments || {}
  const task = String(input.task ?? '').trim()
  if (!task) {
    sendError(message.id, 'subagent requires a non-empty "task".')
    return
  }
  const name = String(input.agent ?? '').trim().toLowerCase() || DEFAULT_AGENT
  const agent = AGENTS[name]
  if (!agent) {
    sendError(message.id, `subagent "agent" must be one of: ${Object.keys(AGENTS).join(', ')}.`)
    return
  }
  const timeoutSeconds = input.timeout_seconds === undefined
    ? defaultTimeoutSeconds
    : Number(input.timeout_seconds)
  if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) {
    sendError(message.id, 'subagent "timeout_seconds" must be a positive number.')
    return
  }
  const result = await runSubagent({
    id: message.id,
    task,
    label: makeLabel(input.label, task),
    agent,
    model: agent.model || defaultModel,
    timeoutSeconds
  })
  send({
    type: 'response',
    id: message.id,
    content: [{ type: 'text', text: result.text }],
    is_error: result.isError
  })
}

// /subagent [agent] <task> runs one subagent and prints its report. A leading
// word only counts as an agent when it names one, so a normal task is safe.
async function handleCommand(message) {
  const args = String(message.arguments ?? '').trim()
  const first = args.split(/\s+/)[0].toLowerCase()
  const name = AGENTS[first] ? first : DEFAULT_AGENT
  const task = AGENTS[first] ? args.slice(first.length).trim() : args
  if (!task) {
    send({ type: 'response', id: message.id, message: usageText() })
    return
  }
  const result = await runSubagent({
    id: `command:${message.id}`,
    task,
    label: makeLabel('', task),
    agent: AGENTS[name],
    model: AGENTS[name].model || defaultModel,
    timeoutSeconds: defaultTimeoutSeconds
  })
  send({ type: 'response', id: message.id, message: result.text })
}

const input = readline.createInterface({ input: process.stdin })
input.on('line', (line) => {
  if (!line.trim()) return
  let message
  try { message = JSON.parse(line) } catch { return }
  if (message.type === 'initialize') {
    workspace = message.workspace || workspace
  } else if (message.type === 'tool' && message.name === 'subagent') {
    handleTool(message).catch((err) => {
      sendError(message.id, `subagent failed: ${err.message}`)
    })
  } else if (message.type === 'command' && message.name === 'subagent') {
    handleCommand(message).catch((err) => {
      send({ type: 'response', id: message.id, message: `subagent failed: ${err.message}` })
    })
  } else if (message.type === 'cancel') {
    // niminal has given up on this tool call and drops the response, so stop the
    // child instead of letting it work and bill until its timeout.
    const run = runs.get(message.id)
    if (run) {
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
