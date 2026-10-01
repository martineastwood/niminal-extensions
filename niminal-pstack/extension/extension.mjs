#!/usr/bin/env node
// niminal-pstack: Shift-Tab Poteto mode, /setup-pstack, and pstack config tools.
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import readline from 'node:readline'

const send = (message) => process.stdout.write(JSON.stringify(message) + '\n')

const ROLE_NAMES = [
  'feature, refactoring',
  'bug-fix',
  'perf-issue',
  'hillclimb',
  'judgment and prose',
  'hardest tasks',
  'how explorer',
  'how explainer',
  'why investigators',
  'why synthesizer',
  'reflect tooling',
  'reflect judgment, divergent, synthesizer',
  'arena runners',
  'arena cross-judge pool',
  'swarm workers',
  'architect runners',
  'interrogate reviewers'
]

const CONFIG_DIR = join(homedir(), '.niminal', 'pstack')
const CONFIG_PATH = join(CONFIG_DIR, 'models.json')
const SESSIONS_ROOT = join(homedir(), '.niminal', 'sessions')

let workspace = process.cwd()
let sessionId = process.env.NIMINAL_SESSION_ID || ''
let nextUiId = 0
const pendingUi = new Map()

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

function defaultConfig() {
  return {
    version: 1,
    roles: Object.fromEntries(ROLE_NAMES.map((role) => [role, 'inherit-parent']))
  }
}

function readConfig() {
  const parsed = readJson(CONFIG_PATH)
  if (!parsed || parsed.version !== 1 || !parsed.roles || typeof parsed.roles !== 'object') {
    return defaultConfig()
  }
  const roles = { ...defaultConfig().roles }
  for (const [role, value] of Object.entries(parsed.roles)) {
    if (typeof value === 'string' ||
        (Array.isArray(value) && value.every((item) => typeof item === 'string'))) {
      roles[role] = value
    }
  }
  return { version: 1, roles }
}

function writeConfig(config) {
  mkdirSync(CONFIG_DIR, { recursive: true })
  writeFileSync(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 })
}

function recentModels() {
  const cfg = readJson(join(homedir(), '.niminal', 'config.json')) || {}
  const found = new Set(['inherit-parent'])
  if (typeof cfg.model === 'string' && cfg.model.trim()) found.add(cfg.model.trim())
  if (cfg.last_models && typeof cfg.last_models === 'object') {
    for (const value of Object.values(cfg.last_models)) {
      if (typeof value === 'string' && value.trim()) found.add(value.trim())
    }
  }
  return [...found]
}

function uiRequest(method, fields) {
  const id = `pstack-ui-${++nextUiId}-${randomBytes(3).toString('hex')}`
  return new Promise((resolve) => {
    pendingUi.set(id, resolve)
    send({ type: 'ui_request', id, method, ...fields })
  })
}

function listSessionFiles() {
  if (!existsSync(SESSIONS_ROOT)) return []
  const files = []
  const walk = (dir) => {
    let entries = []
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) files.push(path)
    }
  }
  walk(SESSIONS_ROOT)
  return files.sort()
}

const POTETO_PROMPT =
  'Current mode: POTETO (pstack). Follow the poteto-mode skill. At the start of ' +
  'non-trivial work, load /skill:poteto-mode (or call the skill tool with name ' +
  'poteto-mode), match a playbook, and copy its steps into a todo list. Name only ' +
  'principles whose leaf skills you read this session and the decisions they changed. ' +
  'Delegate with the subagent tool (agent poteto-agent for implementation; use ' +
  'worktree:true for parallel writers). Verify real behavior before declaring done. ' +
  'Configure models with /setup-pstack. Prefer project-native verification tooling; do ' +
  'not assume Cursor Team Kit, cloud agents, or Task.'

const POTETO_TOOLS = [
  'read', 'grep', 'glob', 'ls', 'edit', 'write', 'git', 'bash', 'skill', 'ask_user',
  'subagent', 'subagent_result', 'todo', 'pstack_config', 'pstack_sessions', 'pstack_todo'
]

send({
  type: 'register',
  commands: [{
    name: 'setup-pstack',
    description: 'Map pstack delegation roles to models (writes ~/.niminal/pstack/models.json)'
  }],
  modes: [{
    id: 'poteto',
    label: 'Poteto',
    prompt: POTETO_PROMPT,
    tools: POTETO_TOOLS,
    permissions: 'ask'
  }],
  tools: [{
    name: 'pstack_config',
    description:
      'Read or update pstack role-to-model configuration at ~/.niminal/pstack/models.json. ' +
      'Use list-models before setting a model. inherit-parent makes a subagent use the parent ' +
      'session model.',
    input_schema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['get', 'list-models', 'set'],
          description: 'get the config, list candidate models, or set a role'
        },
        role: { type: 'string', description: 'Role name for set, e.g. bug-fix' },
        model: { type: 'string', description: 'Model id or inherit-parent' },
        models: {
          type: 'array',
          items: { type: 'string' },
          description: 'Ordered model pool for a panel role'
        }
      },
      required: ['action']
    },
    capabilities: ['read', 'write']
  }, {
    name: 'pstack_sessions',
    description:
      'List niminal session files under ~/.niminal/sessions for session pickup. Use before ' +
      'reading prior transcripts.',
    input_schema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list'] }
      },
      required: ['action']
    },
    capabilities: ['read']
  }, {
    name: 'pstack_todo',
    description:
      'Maintain pstack\'s current task checklist when the todo extension is unavailable. ' +
      'Prefer the todo tool when it is installed. Use at the start of non-trivial multi-step ' +
      'work, then update it as work advances.',
    input_schema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['get', 'set', 'add', 'complete'] },
        items: { type: 'array', items: { type: 'string' } },
        item: { type: 'string' }
      },
      required: ['action']
    },
    capabilities: ['read', 'write']
  }],
  events: ['session_start']
})

let todos = []

function respondText(id, text, isError = false) {
  send({
    type: 'response',
    id,
    content: [{ type: 'text', text }],
    ...(isError ? { is_error: true } : {})
  })
}

async function handleSetup(message) {
  let config = readConfig()
  const candidates = recentModels().slice(0, 4)
  try {
    for (const role of ROLE_NAMES) {
      const current = Array.isArray(config.roles[role])
        ? config.roles[role].join(', ')
        : config.roles[role]
      const options = [...new Set([
        'inherit-parent',
        ...(candidates.filter((item) => item !== 'inherit-parent')),
        'skip remaining'
      ])].slice(0, 4)
      const answer = await uiRequest('question', {
        prompt: `Model for ${role} (current: ${current})`,
        options
      })
      if (answer.cancelled || !answer.answer || answer.answer === 'skip remaining') break
      config.roles[role] = answer.answer
    }
  } catch (err) {
    writeConfig(defaultConfig())
    send({
      type: 'response',
      id: message.id,
      message: `Wrote default inherit-parent config to ${CONFIG_PATH} (${err.message}). ` +
        'Use pstack_config to customize.'
    })
    return
  }
  writeConfig(config)
  send({
    type: 'response',
    id: message.id,
    message: `Saved pstack model settings to ${CONFIG_PATH}. Shift-Tab to Poteto, then use ` +
      '/skill:poteto-mode for playbooks. Re-run /setup-pstack anytime.'
  })
}

function handleConfig(message) {
  const input = message.arguments || {}
  if (input.action === 'list-models') {
    const models = recentModels()
    respondText(message.id, models.join('\n') || 'inherit-parent')
    return
  }
  const config = readConfig()
  if (input.action === 'set') {
    if (!input.role || (!input.model && !input.models?.length)) {
      respondText(message.id, 'pstack_config set requires role plus model or models.', true)
      return
    }
    if (!ROLE_NAMES.includes(input.role) && !(input.role in config.roles)) {
      // Allow custom role keys for forward compatibility, but warn via text.
    }
    config.roles[input.role] = input.models?.length ? input.models : input.model
    writeConfig(config)
  }
  respondText(message.id, JSON.stringify(config, null, 2))
}

function handleSessions(message) {
  const files = listSessionFiles()
  const text = files.length
    ? files.join('\n')
    : 'No saved sessions under ~/.niminal/sessions.'
  respondText(message.id, text)
}

function handleTodo(message) {
  const input = message.arguments || {}
  if (input.action === 'set') todos = Array.isArray(input.items) ? input.items.map(String) : []
  if (input.action === 'add' && input.item) todos = [...todos, String(input.item)]
  if (input.action === 'complete' && input.item) {
    todos = todos.map((item) => item === input.item ? `[done] ${item}` : item)
  }
  const text = todos.length
    ? todos.map((item, index) => `${index + 1}. ${item}`).join('\n')
    : 'No pstack todo items.'
  respondText(message.id, text)
}

const input = readline.createInterface({ input: process.stdin })
input.on('line', (line) => {
  if (!line.trim()) return
  let message
  try {
    message = JSON.parse(line)
  } catch {
    return
  }
  if (message.type === 'initialize') {
    workspace = message.workspace || workspace
    sessionId = message.session_id || sessionId
  } else if (message.type === 'event' && message.event === 'session_start') {
    sessionId = message.payload?.session_id || sessionId || sessionId
    todos = []
    send({ type: 'response', id: message.id })
  } else if (message.type === 'ui_response') {
    const resolve = pendingUi.get(message.id)
    if (resolve) {
      pendingUi.delete(message.id)
      resolve(message)
    }
  } else if (message.type === 'command' && message.name === 'setup-pstack') {
    handleSetup(message).catch((err) => {
      send({
        type: 'response',
        id: message.id,
        message: `setup-pstack failed: ${err.message}`
      })
    })
  } else if (message.type === 'tool' && message.name === 'pstack_config') {
    try {
      handleConfig(message)
    } catch (err) {
      respondText(message.id, `pstack_config failed: ${err.message}`, true)
    }
  } else if (message.type === 'tool' && message.name === 'pstack_sessions') {
    try {
      handleSessions(message)
    } catch (err) {
      respondText(message.id, `pstack_sessions failed: ${err.message}`, true)
    }
  } else if (message.type === 'tool' && message.name === 'pstack_todo') {
    try {
      handleTodo(message)
    } catch (err) {
      respondText(message.id, `pstack_todo failed: ${err.message}`, true)
    }
  } else if (message.type === 'shutdown') {
    process.exit(0)
  } else if (message.id !== undefined) {
    send({ type: 'response', id: message.id })
  }
})

input.on('close', () => process.exit(0))
