import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import readline from 'node:readline'
import test from 'node:test'

function launch(t) {
  const child = spawn(process.execPath, [new URL('./extension.mjs', import.meta.url).pathname])
  const queue = []
  const waiters = []
  readline.createInterface({ input: child.stdout }).on('line', (line) => {
    const value = JSON.parse(line)
    const resolve = waiters.shift()
    if (resolve) resolve(value)
    else queue.push(value)
  })
  t.after(() => child.kill())
  const next = () => queue.length ? Promise.resolve(queue.shift()) : new Promise(resolve => waiters.push(resolve))
  return {
    send: value => child.stdin.write(JSON.stringify(value) + '\n'),
    async until(predicate) {
      for (;;) {
        const value = await next()
        if (predicate(value)) return value
      }
    }
  }
}

const isRequest = value => value.type === 'host_request'
const command = (id, messages = [], question = '') => ({ type: 'command', name: 'btw', id, arguments: question, context: { messages } })
const submit = (widget, text) => ({ type: 'ui_action', widget, action: 'submit', text })
const answer = (request, text) => ({ type: 'host_response', id: request.id, result: { text } })

test('modal retains side conversation and captures all available context once', { timeout: 5000 }, async t => {
  const app = launch(t)
  await app.until(value => value.type === 'register')
  const messages = Array.from({ length: 20 }, (_, i) => ({ role: 'user', content: `main message ${i}` }))
  messages[0].content += 'x'.repeat(2000)
  app.send(command('open', messages))
  const opened = await app.until(value => value.id === 'open')
  assert.equal(opened.widget.position, 'modal')
  assert.ok(opened.widget.actions.some(action => action.id === 'submit'))
  const key = opened.widget.key
  app.send(submit(key, 'Why retry?'))
  const first = await app.until(isRequest)
  assert.match(first.prompt, /main message 0x{2000}/)
  assert.match(first.prompt, /main message 19/)
  assert.equal(first.read_only_tools, true)
  app.send(answer(first, 'Transient failures.'))
  const completed = await app.until(value => value.widget?.content?.[0]?.text.includes('Transient failures.'))
  assert.match(completed.widget.content[0].text, /Why retry\?/)
  app.send(submit(key, 'How often?'))
  const second = await app.until(isRequest)
  assert.match(second.prompt, /Q: Why retry\?\nA: Transient failures\./)
  assert.match(second.prompt, /main message 19/)
  app.send(answer(second, 'Three times.'))
  const followup = await app.until(value => value.widget?.content?.[0]?.text.includes('Three times.'))
  assert.match(followup.widget.content[0].text, /Transient failures\./)
  assert.match(followup.widget.content[0].text, /How often\?/)
})

test('close and reopen during a request discards history and late answers', { timeout: 5000 }, async t => {
  const app = launch(t)
  await app.until(value => value.type === 'register')
  app.send(command('old', [{ role: 'user', content: 'old background' }], 'Old question'))
  const old = await app.until(value => value.id === 'old')
  const first = await app.until(isRequest)
  app.send({ type: 'ui_action', widget: old.widget.key, action: 'close' })
  await app.until(value => value.widget?.key === old.widget.key && value.widget.content.length === 0)
  app.send(command('new', [{ role: 'user', content: 'new background' }]))
  const opened = await app.until(value => value.id === 'new')
  assert.notEqual(opened.widget.key, old.widget.key)
  app.send(submit(old.widget.key, 'Stale submission'))
  app.send(submit(opened.widget.key, 'New question'))
  const second = await app.until(isRequest)
  assert.match(second.prompt, /new background/)
  assert.ok(!second.prompt.includes('old background'))
  assert.ok(!second.prompt.includes('Old question'))
  app.send(answer(first, 'Discard this answer'))
  app.send(answer(second, 'Current answer'))
  const values = []
  const result = await app.until(value => {
    values.push(value)
    return value.widget?.content?.[0]?.text.includes('Current answer')
  })
  assert.ok(values.every(value => !value.widget?.content?.[0]?.text.includes('Discard this answer')))
  assert.equal(result.widget.key, opened.widget.key)
})

test('session change closes modal, and failures permit another question', { timeout: 5000 }, async t => {
  const app = launch(t)
  await app.until(value => value.type === 'register')
  app.send(command('open', [], 'Question'))
  const opened = await app.until(value => value.id === 'open')
  const request = await app.until(isRequest)
  app.send({ type: 'host_response', id: request.id, error: 'Provider unavailable' })
  const failed = await app.until(value => value.widget?.content?.[0]?.text.includes('Provider unavailable'))
  assert.ok(failed.widget.actions.some(action => action.id === 'submit'))
  app.send(submit(opened.widget.key, 'Try again'))
  const retry = await app.until(isRequest)
  assert.ok(!retry.prompt.includes('Provider unavailable'))
  app.send({ type: 'event', event: 'session_start', id: 'session' })
  await app.until(value => value.widget?.key === opened.widget.key && value.widget.content.length === 0)
  await app.until(value => value.id === 'session')
  app.send(answer(retry, 'Late reply'))
  app.send(command('fresh'))
  const fresh = await app.until(value => value.id === 'fresh')
  assert.equal(fresh.widget.content[0].text, 'Ask a side question about this session.')
})
