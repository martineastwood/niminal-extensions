import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
  return { send, launches, messages, exited }
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

test('shutdown stops active children without launching queued work', async t => {
  const f = fixture(t)
  f.send({ type: 'tool', name: 'subagent', id: 1,
    arguments: { tasks: [{ task: 'first' }, { task: 'queued' }], run_in_background: true } })
  await until(() => f.launches().length === 1)
  f.send({ type: 'shutdown' })
  await f.exited
  assert.equal(f.launches().length, 1)
})
