#!/usr/bin/env node
// btw: ask a side question without adding it to the main conversation.
//
// /btw <question> sends the question to the active model with the conversation
// so far as background, and shows the answer in a panel above the composer.
// The main thread, its model context, and the saved session are untouched, so
// you can check a detail without steering the agent off its task. Follow-up
// questions continue the side thread, which lives in this process.
import { randomUUID } from 'node:crypto'
import readline from 'node:readline'

const WIDGET_KEY = 'btw'
const PANEL_HEIGHT = 12
const MAX_MESSAGE_CHARS = 1500
const MAX_CONTEXT_CHARS = 24000
const KEEP_MESSAGES = 12
const KEEP_EXCHANGES = 6

const SYSTEM_PROMPT =
  'You answer side questions about an ongoing coding session. Another agent is working ' +
  'on the main task and the user is asking you off to the side.\n\n' +
  'Use the conversation so far as background. Answer directly and briefly: a few ' +
  'sentences, or a short list when that is clearer.\n\n' +
  'You may inspect workspace files with read-only tools to answer questions about the code. ' +
  'Do not propose edits, edit files, or run shell commands. Do not repeat the ' +
  'conversation back. If the conversation and workspace do not answer the question, say ' +
  'what would have to be checked instead of guessing.'

const exchanges = []
const pending = new Map()
let active = false
// Close while a request is in flight abandons that answer so a late result does
// not reopen the panel. True host-side cancel of model.complete comes later.
let abandoned = false

const send = (message) => process.stdout.write(JSON.stringify(message) + '\n')

// The host answers host_request lines on its reader thread, so the reply can
// arrive while we are still handling a command.
function hostRequest(method, fields) {
  const id = randomUUID()
  return new Promise((resolve) => {
    pending.set(id, resolve)
    send({ type: 'host_request', id, method, ...fields })
  })
}

function partText(part) {
  if (part.type === 'text') return part.text ?? ''
  if (part.type === 'source') return `[source: ${part.title || part.url || ''}]`
  if (part.type === 'image' || part.type === 'file') return `[${part.type}]`
  return ''
}

// Messages arrive in OpenAI shape: a plain string for text, parts when the user
// attached an image, and tool_calls on assistant turns.
function messageText(message) {
  const content = message?.content
  let body = ''
  if (typeof content === 'string') {
    body = content
  } else if (Array.isArray(content)) {
    body = content
      .filter((part) => part && typeof part === 'object')
      .map(partText)
      .filter(Boolean)
      .join('\n')
  }
  const calls = message?.tool_calls
  if (Array.isArray(calls) && calls.length) {
    const names = calls.map((call) => call?.function?.name ?? 'tool')
    body = [body, `[calls: ${names.join(', ')}]`].filter(Boolean).join('\n')
  }
  return body.length > MAX_MESSAGE_CHARS
    ? body.slice(0, MAX_MESSAGE_CHARS) + '\n[truncated]'
    : body
}

// Recent turns only, oldest dropped first: a side question should cost a
// fraction of a main-thread request.
function conversation(messages) {
  const blocks = []
  const recent = messages.filter((item) => item && item.role !== 'system').slice(-KEEP_MESSAGES)
  for (const message of recent) {
    const body = messageText(message).trim()
    if (body) blocks.push(`${String(message.role ?? 'message').toUpperCase()}:\n${body}`)
  }
  let total = blocks.reduce((sum, block) => sum + block.length, 0)
  while (blocks.length && total > MAX_CONTEXT_CHARS) {
    total -= blocks.shift().length
  }
  return blocks.join('\n\n')
}

// The panel body is markdown, rendered and scrolled by niminal, so the answer
// keeps its headings, lists, and code blocks however long it gets. Close stays
// available while Thinking so the side question can be abandoned early.
function panel(question, answer) {
  return {
    key: WIDGET_KEY,
    title: 'btw',
    content: [{
      type: 'markdown',
      text: `**Q:** ${question}\n\n${answer}`,
      height: PANEL_HEIGHT
    }],
    actions: [{ id: 'close', label: 'Close' }]
  }
}

function clearPanel() {
  send({
    type: 'update',
    widget: { key: WIDGET_KEY, title: '', content: [], actions: [] }
  })
}

function thinking(activeThinking) {
  send({
    type: 'update',
    status: {
      key: WIDGET_KEY,
      segments: activeThinking
        ? [{ text: ' btw ', style: 'emphasis' }, { text: 'thinking', style: 'accent' }]
        : []
    }
  })
}

function deny(id, message) {
  send({ type: 'response', id, message })
}

// niminal repaints only after a command answers, so the command returns as soon
// as the panel is open and the answer follows as an update. Answering with the
// model's reply instead would leave /btw looking dead until it arrived.
function openPanel(id, question) {
  send({ type: 'response', id, widget: panel(question, 'Thinking…') })
}

function showAnswer(question, text) {
  if (abandoned) return
  send({ type: 'update', widget: panel(question, text) })
}

async function ask(message) {
  const question = String(message.arguments ?? '').trim()
  if (!question) {
    deny(message.id, 'Usage: /btw <side question>')
    return
  }
  if (active) {
    deny(message.id, 'btw is still answering the previous question')
    return
  }
  active = true
  abandoned = false
  const context = message.context ?? {}
  const sections = []
  const history = conversation(Array.isArray(context.messages) ? context.messages : [])
  if (history) sections.push(`## Conversation so far\n\n${history}`)
  if (exchanges.length) {
    const thread = exchanges
      .slice(-KEEP_EXCHANGES)
      .map(([asked, answered]) => `Q: ${asked}\nA: ${answered}`)
      .join('\n\n')
    sections.push(`## Earlier side questions\n\n${thread}`)
  }
  sections.push(`## Side question\n\n${question}`)

  thinking(true)
  openPanel(message.id, question)
  try {
    const result = await hostRequest('model.complete', {
      system_prompt: SYSTEM_PROMPT,
      prompt: sections.join('\n\n'),
      max_tokens: 900,
      read_only_tools: true
    })
    if (abandoned) return
    if (!result || result.cancelled) {
      showAnswer(question, 'btw cancelled')
      return
    }
    if (result.error) {
      showAnswer(question, `btw failed: ${result.error}`)
      return
    }
    const answer = String(result.result?.text ?? '').trim()
    if (!answer) {
      showAnswer(question, 'btw got no answer back')
      return
    }
    exchanges.push([question, answer])
    showAnswer(question, answer)
  } finally {
    active = false
    thinking(false)
  }
}

function act(message) {
  if (message.action === 'close') {
    if (active) abandoned = true
    clearPanel()
  }
}

send({
  type: 'register',
  commands: [{
    name: 'btw',
    description: 'Ask a side question without touching the main conversation',
    while_busy: true
  }]
})

const input = readline.createInterface({ input: process.stdin })
input.on('line', (line) => {
  if (!line.trim()) return
  let message
  try { message = JSON.parse(line) } catch { return }
  if (message.type === 'host_response') {
    const resolve = pending.get(message.id)
    if (resolve) {
      pending.delete(message.id)
      resolve(message)
    }
  } else if (message.type === 'command' && message.name === 'btw') {
    ask(message).catch((err) => {
      showAnswer(String(message.arguments ?? '').trim(), `btw failed: ${err.message}`)
    })
  } else if (message.type === 'ui_action' && message.widget === WIDGET_KEY) {
    act(message)
  } else if (message.type === 'cancel') {
    for (const resolve of pending.values()) resolve(null)
    pending.clear()
  } else if (message.type === 'shutdown') {
    process.exit(0)
  }
})
// niminal may exit without asking (killed, or the terminal is gone).
input.on('close', () => process.exit(0))
