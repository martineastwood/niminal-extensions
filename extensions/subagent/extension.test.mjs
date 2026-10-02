import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import readline from 'node:readline'
import { test } from 'node:test'

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'niminal-subagent-test-'))
  const log = join(dir, 'children.jsonl')
  const binary = join(dir, 'mock.mjs')
  writeFileSync(log, '')
  writeFileSync(binary, `#!/usr/bin/env node
import { appendFileSync } from 'node:fs'
appendFileSync(process.env.MOCK_LOG, JSON.stringify(process.argv.slice(2)) + '\\n')
process.stdin.resume()
setInterval(() => {}, 1000)
`, { mode: 0o755 })
  const child = spawn(process.execPath, [new URL('./extension.mjs', import.meta.url).pathname], {
    cwd: dir,
    env: { ...process.env, HOME: dir, NIMINAL_BIN: binary, MOCK_LOG: log,
      NIMINAL_TRUSTED: '0', NIMINAL_PROVIDER: 'initial-provider',
      SUBAGENT_MAX_CONCURRENT: '1' },
    stdio: ['pipe', 'pipe', 'pipe']
  })
  const messages = []
  readline.createInterface({ input: child.stdout }).on('line', line => messages.push(JSON.parse(line)))
  const exited = new Promise(resolve => child.once('close', resolve))
  const send = message => child.stdin.write(JSON.stringify(message) + '\n')
  const launches = () => readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse)
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) send({ type: 'shutdown' })
    await exited
    rmSync(dir, { recursive: true, force: true })
  })
  return { send, launches, messages, exited, dir }
}

// Global agent files live under <home>/.niminal/subagents/, so a fixture HOME
// gives each test its own agent list.
function addAgent(dir, name, tools) {
  const agents = join(dir, '.niminal', 'subagents')
  mkdirSync(agents, { recursive: true })
  writeFileSync(join(agents, `${name}.md`),
    `---\nname: ${name}\ndescription: test agent\n${tools ? `tools: ${tools}\n` : ''}---\nDo the task.\n`)
}

async function until(predicate) {
  const deadline = Date.now() + 3000
  while (!predicate()) {
    assert.ok(Date.now() < deadline, 'timed out waiting for extension')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

test('passes the current session provider to child sessions', async t => {
  const f = fixture(t)
  f.send({ type: 'event', event: 'session_settings_changed', id: 1,
    payload: { provider: 'current-provider' } })
  f.send({ type: 'tool', name: 'subagent', id: 2,
    arguments: { task: 'inspect code', run_in_background: true } })
  await until(() => f.launches().length === 1)
  const args = f.launches()[0]
  assert.equal(args[args.indexOf('--provider') + 1], 'current-provider')
})

test('rejects an invalid batch before launching any children', async t => {
  const f = fixture(t)
  f.send({ type: 'tool', name: 'subagent', id: 1,
    arguments: { tasks: [{ task: 'valid' }, { task: '' }] } })
  await until(() => f.messages.some(message => message.type === 'response' && message.id === 1))
  assert.equal(f.messages.find(message => message.type === 'response' && message.id === 1).is_error, true)
  assert.deepEqual(f.launches(), [])
})

// The fixture runs one child at a time and the mock never exits, so each case
// observes the single launch it triggers. An `agent` that is not `probe` must be
// a built-in, and no agent file is written for it.
async function launchArgs(t, tools, task, agent = 'probe') {
  const f = fixture(t)
  if (agent === 'probe') addAgent(f.dir, 'probe', tools)
  f.send({ type: 'tool', name: 'subagent', id: 1, arguments: { task, agent } })
  await until(() => f.launches().length === 1)
  const args = f.launches()[0]
  return { tools: args[args.indexOf('--tools') + 1], prompt: args[args.indexOf('--append-system-prompt') + 1] }
}

test('a read-only extra tool does not mark an agent as a writer', async t => {
  const gitOnly = await launchArgs(t, 'read,grep,glob,ls,git', 'inspect history')
  assert.equal(gitOnly.tools, 'read,grep,glob,ls,git')
  assert.match(gitOnly.prompt, /You cannot change files/)
})

test('a write tool marks an agent as a writer', async t => {
  const shell = await launchArgs(t, 'read,grep,glob,ls,bash', 'run a command')
  assert.match(shell.prompt, /Describe only edits and commands you actually ran/)
})

test('read-only agents get the git tool', async t => {
  const builtin = await launchArgs(t, null, 'review history', 'reviewer')
  assert.equal(builtin.tools, 'read,grep,glob,ls,git')
  const fromDefault = await launchArgs(t, null, 'inspect history')
  assert.equal(fromDefault.tools, 'read,grep,glob,ls,git,skill')
})

test('shutdown stops active children without launching queued work', async t => {
  const f = fixture(t)
  f.send({ type: 'tool', name: 'subagent', id: 1,
    arguments: { tasks: [{ task: 'first' }, { task: 'queued' }], run_in_background: true } })
  await until(() => f.launches().length === 1)
  f.send({ type: 'shutdown' })
  await f.exited
  assert.equal(f.launches().length, 1)
})
