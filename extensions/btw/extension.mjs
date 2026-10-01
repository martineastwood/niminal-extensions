#!/usr/bin/env node
import { randomUUID } from 'node:crypto'
import readline from 'node:readline'

const SYSTEM_PROMPT =
  'You answer side questions about an ongoing coding session. Another agent is working ' +
  'on the main task and the user is asking you off to the side.\n\n' +
  'Use the conversation so far as background. Answer directly and concisely, ' +
  'unless the user asks for more detail.\n\n' +
  'You may inspect workspace files with read-only tools to answer questions about the code. ' +
  'Do not edit files or run shell commands. Do not repeat the ' +
  'conversation back. If the conversation and workspace do not answer the question, say ' +
  'what would have to be checked instead of guessing.'

let thread = null
const pending = new Map()
const send = (message) => process.stdout.write(JSON.stringify(message) + '\n')

function hostRequest(fields) {
  const id = randomUUID()
  return new Promise((resolve) => {
    pending.set(id, resolve)
    send({ type: 'host_request', id, method: 'model.complete', ...fields })
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
    const names = calls.map((call) => `${call?.function?.name ?? 'tool'} ${call?.function?.arguments ?? ''}`.trim())
    body = [body, `[calls: ${names.join(', ')}]`].filter(Boolean).join('\n')
  }
  return body
}

function widget(current) {
  const transcript = current.messages.map(([role, text]) => `### ${role}\n\n${text}`).join('\n\n')
  return {
    key: current.key,
    position: 'modal',
    title: 'btw',
    content: [{ type: 'markdown', text: transcript || 'Ask a side question about this session.' }],
    actions: [
      ...(!current.active ? [{ id: 'submit', label: 'Send' }] : []),
      { id: 'close', label: 'Close' }
    ]
  }
}

function update(current) {
  if (thread === current) send({ type: 'update', widget: widget(current) })
}

function close() {
  if (!thread) return
  send({ type: 'update', widget: { key: thread.key, title: '', content: [], actions: [] } })
  thread = null
}

async function ask(current, question) {
  if (current.active || !question) return
  current.active = true
  current.messages.push(['You', question])
  const earlier = current.exchanges.map(([asked, answered]) => `Q: ${asked}\nA: ${answered}`).join('\n\n')
  current.messages.push(['btw', 'Thinking…'])
  update(current)
  try {
    const result = await hostRequest({
      system_prompt: SYSTEM_PROMPT,
      prompt: `## Main conversation at opening\n\n${current.background}\n\n## Side conversation\n\n${earlier}\n\n## Side question\n\n${question}`,
      read_only_tools: true
    })
    if (thread !== current) return
    const answer = String(result?.result?.text ?? '').trim()
    const text = result?.error ? `btw failed: ${result.error}`
      : !result || result.cancelled ? 'btw cancelled'
      : answer || 'btw got no answer back'
    current.messages[current.messages.length - 1] = ['btw', text]
    if (answer && !result.error && !result.cancelled) current.exchanges.push([question, answer])
  } catch (error) {
    current.messages[current.messages.length - 1] = ['btw', `btw failed: ${error.message}`]
  } finally {
    current.active = false
    update(current)
  }
}

function open(message) {
  close()
  const messages = message.context?.messages
  thread = {
    key: `btw-${randomUUID()}`,
    background: (Array.isArray(messages) ? messages : [])
      .filter((message) => message && message.role !== 'system')
      .map((message) => `${String(message.role ?? 'message').toUpperCase()}:\n${messageText(message)}`)
      .join('\n\n'),
    messages: [], exchanges: [], active: false
  }
  send({ type: 'response', id: message.id, widget: widget(thread) })
  const question = String(message.arguments ?? '').trim()
  if (question) void ask(thread, question)
}

send({
  type: 'register',
  commands: [{ name: 'btw', description: 'Open a separate side conversation', while_busy: true }],
  events: ['session_start']
})

const input = readline.createInterface({ input: process.stdin })
input.on('line', (line) => {
  let message
  try { message = JSON.parse(line) } catch { return }
  if (message.type === 'host_response') {
    const resolve = pending.get(message.id)
    pending.delete(message.id)
    resolve?.(message)
  } else if (message.type === 'command' && message.name === 'btw') {
    open(message)
  } else if (message.type === 'event' && message.event === 'session_start') {
    close()
    send({ type: 'response', id: message.id })
  } else if (message.type === 'ui_action' && message.widget === thread?.key) {
    if (message.action === 'close') close()
    else if (message.action === 'submit') void ask(thread, String(message.text ?? '').trim())
  } else if (message.type === 'cancel') {
    for (const resolve of pending.values()) resolve(null)
    pending.clear()
  } else if (message.type === 'shutdown') {
    process.exit(0)
  }
})
input.on('close', () => process.exit(0))
