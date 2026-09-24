#!/usr/bin/env node
// spawn_agent: expose niminal subagents as a model tool.
//
// Each spawn_agent call runs "niminal --mode json --no-session" in a fresh
// session, streams progress into the active tool display, and returns the
// subagent's final report with its token usage. Subagents cannot spawn
// further subagents.
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import readline from 'node:readline'

const send = (message) => process.stdout.write(JSON.stringify(message) + '\n')

let workspace = process.cwd()

send({
  type: 'register',
  commands: [],
  tools: [{
    name: 'spawn_agent',
    description:
      'Run an isolated subagent in its own niminal session and return its final report. ' +
      'The subagent cannot see this conversation, so give it a complete, self-contained task ' +
      'including file paths and what to report. Use it for broad investigation, parallel ' +
      'research, and double-checking; do trivial lookups yourself.',
    input_schema: {
      type: 'object',
      properties: {
        task: {
          type: 'string',
          description: 'Complete, self-contained instructions for the subagent.'
        },
        label: {
          type: 'string',
          description: 'Short name shown in progress output, e.g. "parser-investigation".'
        }
      },
      required: ['task']
    },
    capabilities: ['read']
  }]
})

// Subagents run read-only by default and can never call spawn_agent itself.
const DEFAULT_TOOLS = 'read,grep,glob,ls,skill'
const timeoutSeconds = Number(process.env.SPAWN_AGENT_TIMEOUT_SECONDS) || 30 * 60

// Live subagents, so an exiting niminal does not leave them running.
const running = new Set()
// The single in-flight cleanup, shared by every stop trigger below.
let stopping = null
// A subagent gets this long to exit after SIGTERM before it is SIGKILLed. It
// has to fit in the 3s niminal waits before it kills this extension, otherwise
// niminal ends the extension mid-cleanup and the subagent survives it.
const stopGraceMs = 1500

function stopTree(child) {
  if (!child || child.pid === undefined) return Promise.resolve()
  return new Promise((resolve) => {
    const finish = () => {
      // A subagent that ignores SIGTERM has to be killed outright. It stays in
      // this extension's process group, so niminal kills it too if it ends this
      // extension before the escalation below runs.
      try { child.kill('SIGKILL') } catch {}
      running.delete(child)
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
  stopping ??= Promise.all([...running].map(stopTree))
  return stopping
}

function formatTokens(n) {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n)
}

function describeCall(event) {
  const input = event.input || {}
  const detail = input.path || input.command || input.pattern || ''
  return detail ? `: ${String(detail).slice(0, 80)}` : ''
}

function resolveNiminalBin() {
  if (process.env.NIMINAL_BIN) {
    return process.env.NIMINAL_BIN
  }
  const local = `${workspace}/niminal/build/niminal`
  return existsSync(local) ? local : 'niminal'
}

function runSubagent(id, task, label, tools) {
  return new Promise((resolve) => {
    const bin = resolveNiminalBin()
    let child
    try {
      // Not detached: the subagent shares this extension's process group, so a
      // niminal that gives up on this extension still kills the subagent.
      child = spawn(bin,
        ['--mode', 'json', '--no-session', '--tools', tools, task],
        { cwd: workspace, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (err) {
      resolve({ text: `spawn_agent could not start niminal: ${err.message}`, isError: true })
      return
    }
    running.add(child)

    const progress = (text) =>
      send({ type: 'tool_update', id, content: `[${label}] ${text}` })

    let inputTokens = 0
    let outputTokens = 0
    let steps = 0
    let finalText = ''
    let lastError = ''
    let stderrTail = ''
    let stopped = false

    const timer = setTimeout(() => { stopped = true; stopTree(child) }, timeoutSeconds * 1000)
    timer.unref?.()

    readline.createInterface({ input: child.stdout }).on('line', (line) => {
      if (!line.trim()) return
      let event
      try { event = JSON.parse(line) } catch { return }
      if (event.type === 'tool_call') {
        progress(`${event.tool_name}${describeCall(event)}`)
      } else if (event.type === 'step_end' && event.usage) {
        steps++
        inputTokens += event.usage.input_tokens || 0
        outputTokens += event.usage.output_tokens || 0
        progress(`${formatTokens(inputTokens)} in / ${formatTokens(outputTokens)} out`)
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
      running.delete(child)
      resolve({ text: `spawn_agent could not run niminal: ${err.message}`, isError: true })
    })

    child.on('close', (code) => {
      clearTimeout(timer)
      running.delete(child)
      if (finalText) {
        resolve({
          text: `${finalText}\n\n---\nsubagent usage: ${formatTokens(inputTokens)} in / ` +
            `${formatTokens(outputTokens)} out over ${steps} step${steps === 1 ? '' : 's'}`,
          isError: false
        })
      } else if (lastError) {
        resolve({ text: `subagent failed: ${lastError}`, isError: true })
      } else if (stopped || code === null) {
        resolve({ text: `subagent was killed after ${Math.round(timeoutSeconds / 60)} minutes without finishing`, isError: true })
      } else if (code === 0) {
        resolve({ text: 'subagent finished without a report', isError: true })
      } else {
        const lastLine = stderrTail.trim().split('\n').pop() || ''
        resolve({
          text: `subagent exited with status ${code}${lastLine ? `: ${lastLine}` : ''}`,
          isError: true
        })
      }
    })
  })
}

async function handleTool(message) {
  const task = String(message.arguments?.task ?? '').trim()
  if (!task) {
    send({
      type: 'response', id: message.id, is_error: true,
      content: [{ type: 'text', text: 'spawn_agent requires a non-empty "task".' }]
    })
    return
  }
  const label = String(message.arguments?.label ?? '').trim() || task.slice(0, 32)
  const result = await runSubagent(message.id, task, label, DEFAULT_TOOLS)
  send({
    type: 'response',
    id: message.id,
    content: [{ type: 'text', text: result.text }],
    is_error: result.isError
  })
}

const input = readline.createInterface({ input: process.stdin })
input.on('line', (line) => {
  if (!line.trim()) return
  let message
  try { message = JSON.parse(line) } catch { return }
  if (message.type === 'initialize') {
    workspace = message.workspace || workspace
  } else if (message.type === 'tool' && message.name === 'spawn_agent') {
    handleTool(message).catch((err) => {
      send({
        type: 'response', id: message.id, is_error: true,
        content: [{ type: 'text', text: `spawn_agent failed: ${err.message}` }]
      })
    })
  } else if (message.type === 'cancel') {
    // Nothing to clean up: a timeout killed child already reported, and
    // in-flight runs answer through their normal close handler.
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
