import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import vm from 'node:vm'

// Run the extension functions with fake transports, without starting main or servers.
const source = readFileSync(new URL('./extension.mjs', import.meta.url), 'utf8')
  .replace(/^import .*\n/gm, '').replace(/main\(\)\.catch\([\s\S]*$/, '')

function fixture() {
  const messages = []
  const transports = []
  const context = vm.createContext({
    process: { env: { TOKEN: 'secret' }, stdout: { write: line => messages.push(JSON.parse(line)) } },
    Client: class {
      async connect(transport) { transports.push(transport) }
      async listTools() { return { tools: [{ name: 'test', inputSchema: { type: 'object' } }] } }
      async close() {}
    },
    StdioClientTransport: class { constructor(config) { Object.assign(this, config) } }
  })
  vm.runInContext(source, context)
  return { context, messages, transports, run: code => vm.runInContext(code, context) }
}

test('malformed entries do not prevent healthy servers from registering', async () => {
  const f = fixture()
  await f.run('Promise.all([connectServer("bad", null, "test.json"), connectServer("array", [], "test.json"), connectServer("good", {command: "mock"}, "test.json")])')
  assert.equal(f.run('exposeServerTools().length'), 1)
  assert.match(f.run('mcpStatusText()'), /bad: invalid/)
  assert.match(f.run('mcpStatusText()'), /array: invalid/)
  assert.match(f.run('mcpStatusText()'), /good: connected/)
})

test('discovers tools across every cursor page', async () => {
  const f = fixture()
  const cursors = []
  f.context.client = { listTools: async params => {
    cursors.push(params?.cursor)
    return params?.cursor ? { tools: [{ name: 'second' }] } : { tools: [{ name: 'first' }], nextCursor: 'page2' }
  } }
  await f.run('registerConnectedServer("paged", {}, client, "stdio")')
  assert.deepEqual(cursors, [undefined, 'page2'])
  assert.equal(f.run('exposeServerTools().length'), 2)
})

test('rejects every ambiguous route, including case collisions', () => {
  const f = fixture()
  f.run(`servers.set('a__b', {tools: [{name: 'c'}]}); servers.set('a', {tools: [{name: 'b__c'}, {name: 'unique'}]});
    servers.set('UPPER', {tools: [{name: 'tool'}]}); servers.set('upper', {tools: [{name: 'TOOL'}]})`)
  assert.equal(f.run('exposeServerTools().length'), 1)
  assert.equal(f.run('routes.size'), 1)
  assert.equal(f.run('routes.has("a__b__c")'), false)
  assert.match(f.run('mcpStatusText()'), /duplicate tool name rejected: a__b__c/)
  assert.match(f.run('mcpStatusText()'), /duplicate tool name rejected: upper__tool/)
})

test('interpolates local credentials and isolates missing variables', async () => {
  const f = fixture()
  await f.run('connectServer("good", {command: "mock", env: {API_KEY: "Bearer ${env:TOKEN}"}}, "test.json")')
  assert.equal(f.transports[0].env.API_KEY, 'Bearer secret')
  await f.run('connectServer("bad", {command: "mock", env: {API_KEY: "${env:MISSING}"}}, "test.json")')
  assert.equal(f.transports.length, 1)
  assert.match(f.run('mcpStatusText()'), /unset environment variable: MISSING/)
})

test('returns structured JSON when content is empty and preserves text and errors', async () => {
  const f = fixture()
  f.context.client = { callTool: async () => ({ content: [], structuredContent: { count: 2 }, isError: true }) }
  f.run('servers.set("server", {client}); routes.set("server__tool", {server: "server", tool: "tool"})')
  await f.run('handleTool({id: 1, name: "server__tool"})')
  assert.equal(f.messages[0].content[0].text, '{"count":2}')
  assert.equal(f.messages[0].is_error, true)
  f.context.client.callTool = async () => ({ content: [{type: 'text', text: 'answer'}], structuredContent: {count: 2} })
  await f.run('handleTool({id: 2, name: "server__tool"})')
  assert.equal(f.messages[1].content[0].text, 'answer')
})
