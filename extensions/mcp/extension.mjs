#!/usr/bin/env node
// mcp: bridge stdio and remote MCP servers into niminal extension tools.
import { readFileSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import readline from 'node:readline'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'

const send = (message) => process.stdout.write(JSON.stringify(message) + '\n')

const DEFAULT_CAPABILITIES = ['network']
const SUPPORTED_CAPABILITIES = new Set(['read', 'write', 'shell', 'network', 'user'])

/** @type {Map<string, { client: Client, capabilities: string[], tools: object[] }>} */
const servers = new Map()
/** @type {Map<string, { server: string, tool: string }>} */
const routes = new Map()
/** @type {{ name: string, status: string, detail?: string, transport?: string, tools: number }[]} */
const serverStatus = []

function readLine(rl) {
  return new Promise((resolve) => {
    rl.once('line', (line) => resolve(line))
  })
}

function configPaths(workspace, trusted) {
  const home = homedir()
  const paths = [join(home, '.agents', 'mcp.json'), join(home, '.niminal', 'mcp.json')]
  if (trusted) {
    paths.push(join(workspace, '.agents', 'mcp.json'), join(workspace, '.niminal', 'mcp.json'))
  }
  return paths
}

function mergeConfigs(paths) {
  const merged = new Map()
  const notes = []
  for (const path of paths) {
    if (!existsSync(path)) continue
    try {
      const doc = JSON.parse(readFileSync(path, 'utf8'))
      const entries = doc?.mcpServers
      if (!entries || typeof entries !== 'object') {
        notes.push(`${path}: missing mcpServers object`)
        continue
      }
      for (const [name, config] of Object.entries(entries)) {
        merged.set(name, { config, source: path })
      }
    } catch (error) {
      notes.push(`${path}: ${error.message}`)
    }
  }
  return { merged, notes }
}

function serverCapabilities(config) {
  const raw = config?.capabilities
  if (!Array.isArray(raw)) return DEFAULT_CAPABILITIES
  const out = raw.filter((item) => typeof item === 'string' && SUPPORTED_CAPABILITIES.has(item))
  return out.length ? out : DEFAULT_CAPABILITIES
}

function toolName(server, tool) {
  return `${server}__${tool}`
}

function flattenContent(content) {
  const parts = []
  for (const block of content ?? []) {
    if (block?.type === 'text' && typeof block.text === 'string') {
      parts.push(block.text)
    } else if (block?.type === 'image') {
      parts.push('[image content omitted]')
    } else {
      parts.push(JSON.stringify(block))
    }
  }
  return parts.join('\n')
}

function interpolateEnv(value) {
  if (typeof value !== 'string') return value
  const missing = []
  const out = value.replace(/\$\{env:([^}]+)\}/g, (_, name) => {
    const envValue = process.env[name]
    if (envValue === undefined || envValue === '') {
      missing.push(name)
      return ''
    }
    return envValue
  })
  if (missing.length) {
    throw new Error(`unset environment variable: ${missing.join(', ')}`)
  }
  return out
}

function resolveRemoteConfig(config) {
  const url = interpolateEnv(config.url)
  const headers = {}
  if (config.headers && typeof config.headers === 'object') {
    for (const [key, raw] of Object.entries(config.headers)) {
      headers[key] = interpolateEnv(String(raw))
    }
  }
  return { url, headers }
}

function remoteTransport(url, headers, kind) {
  const transportOpts = Object.keys(headers).length
    ? { requestInit: { headers } }
    : undefined
  const target = new URL(url)
  if (kind === 'sse') {
    return new SSEClientTransport(target, transportOpts)
  }
  return new StreamableHTTPClientTransport(target, transportOpts)
}

function remoteTransportMode(config) {
  const type = config.type
  if (type === 'http' || type === 'sse') return type
  if (type !== undefined && type !== null && type !== '') {
    throw new Error(`unsupported type: ${type} (use "http" or "sse")`)
  }
  return 'auto'
}

async function registerConnectedServer(name, config, client, transportLabel) {
  const listed = await client.listTools()
  const tools = (listed.tools ?? []).filter((tool) => tool?.name)
  servers.set(name, { client, capabilities: serverCapabilities(config), tools })
  serverStatus.push({
    name,
    status: 'connected',
    transport: transportLabel,
    tools: tools.length
  })
}

async function connectRemoteServer(name, config, source) {
  let resolved
  try {
    resolved = resolveRemoteConfig(config)
  } catch (error) {
    serverStatus.push({
      name,
      status: 'error',
      detail: error instanceof Error ? error.message : String(error),
      tools: 0
    })
    return
  }

  let mode
  try {
    mode = remoteTransportMode(config)
  } catch (error) {
    serverStatus.push({
      name,
      status: 'error',
      detail: error instanceof Error ? error.message : String(error),
      tools: 0
    })
    return
  }
  const attempts = mode === 'auto' ? ['http', 'sse'] : [mode]
  let lastError = null

  for (let i = 0; i < attempts.length; i++) {
    const kind = attempts[i]
    const client = new Client({ name: 'niminal-mcp', version: '1.0.0' })
    try {
      await client.connect(remoteTransport(resolved.url, resolved.headers, kind))
      await registerConnectedServer(name, config, client, kind)
      return
    } catch (error) {
      lastError = error
      try {
        await client.close()
      } catch {
        // ignore cleanup errors
      }
      if (mode !== 'auto' || i === attempts.length - 1) break
    }
  }

  const message = lastError instanceof Error ? lastError.message : String(lastError)
  const detail = mode === 'auto' && attempts.length > 1
    ? `http and sse failed: ${message} (from ${source})`
    : `${message} (from ${source})`
  serverStatus.push({ name, status: 'error', detail, tools: 0 })
}

async function connectStdioServer(name, config, source) {
  const transport = new StdioClientTransport({
    command: config.command,
    args: Array.isArray(config.args) ? config.args.map(String) : [],
    env: config.env && typeof config.env === 'object' ? config.env : undefined,
    cwd: typeof config.cwd === 'string' ? config.cwd : undefined
  })
  const client = new Client({ name: 'niminal-mcp', version: '1.0.0' })
  try {
    await client.connect(transport)
    await registerConnectedServer(name, config, client, 'stdio')
  } catch (error) {
    try {
      await client.close()
    } catch {
      // ignore cleanup errors
    }
    serverStatus.push({
      name,
      status: 'error',
      detail: error instanceof Error ? error.message : String(error),
      tools: 0
    })
  }
}

async function connectServer(name, config, source) {
  if (config.enabled === false) {
    serverStatus.push({ name, status: 'disabled', tools: 0 })
    return
  }

  const isRemote = typeof config.url === 'string' && config.url.length > 0
  if (isRemote && config.command) {
    serverStatus.push({
      name,
      status: 'invalid',
      detail: `use either url or command, not both (from ${source})`,
      tools: 0
    })
    return
  }
  if (isRemote) {
    await connectRemoteServer(name, config, source)
    return
  }
  if (!config.command || typeof config.command !== 'string') {
    serverStatus.push({
      name,
      status: 'invalid',
      detail: `servers need url or command (from ${source})`,
      tools: 0
    })
    return
  }

  await connectStdioServer(name, config, source)
}

async function connectAll(workspace, trusted) {
  const { merged, notes } = mergeConfigs(configPaths(workspace, trusted))
  for (const note of notes) {
    serverStatus.push({ name: '(config)', status: 'note', detail: note, tools: 0 })
  }
  const jobs = []
  for (const [name, { config, source }] of merged) {
    jobs.push(connectServer(name, config, source))
  }
  await Promise.all(jobs)
}

function exposeServerTools() {
  const tools = []
  for (const [serverName, entry] of servers) {
    for (const tool of entry.tools) {
      const exposed = toolName(serverName, tool.name)
      routes.set(exposed, { server: serverName, tool: tool.name })
      tools.push({
        name: exposed,
        description: tool.description || `MCP tool ${tool.name} from ${serverName}`,
        input_schema: tool.inputSchema && typeof tool.inputSchema === 'object'
          ? tool.inputSchema
          : { type: 'object' },
        capabilities: entry.capabilities
      })
    }
  }
  return tools
}

function toolsForServer(name) {
  const names = []
  for (const [exposed, route] of routes) {
    if (route.server === name) names.push(exposed)
  }
  return names.sort()
}

function mcpStatusText() {
  const lines = ['MCP servers:']
  if (serverStatus.length === 0) {
    lines.push('  (no mcp.json entries found)')
    return lines.join('\n')
  }
  for (const row of serverStatus) {
    let line = `  ${row.name}: ${row.status}`
    if (row.status === 'connected' && row.transport) {
      line += ` (${row.transport}, ${row.tools} tools)`
    } else if (row.tools) {
      line += ` (${row.tools} tools)`
    }
    if (row.detail) line += ` — ${row.detail}`
    lines.push(line)
    for (const tool of toolsForServer(row.name)) {
      lines.push(`    ${tool}`)
    }
  }
  lines.push('')
  lines.push(`Registered tools: ${routes.size}`)
  return lines.join('\n')
}

async function handleTool(message) {
  const route = routes.get(message.name)
  if (!route) {
    send({
      type: 'response',
      id: message.id,
      content: [{ type: 'text', text: `Unknown MCP tool: ${message.name}` }],
      is_error: true
    })
    return
  }
  const entry = servers.get(route.server)
  if (!entry) {
    send({
      type: 'response',
      id: message.id,
      content: [{ type: 'text', text: `MCP server not connected: ${route.server}` }],
      is_error: true
    })
    return
  }
  const args = message.arguments && typeof message.arguments === 'object' ? message.arguments : {}
  try {
    const result = await entry.client.callTool({ name: route.tool, arguments: args })
    const text = flattenContent(result.content)
    send({
      type: 'response',
      id: message.id,
      content: [{ type: 'text', text: text || '(empty result)' }],
      is_error: Boolean(result.isError)
    })
  } catch (error) {
    send({
      type: 'response',
      id: message.id,
      content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }],
      is_error: true
    })
  }
}

async function shutdownAll() {
  for (const [, entry] of servers) {
    try {
      await entry.client.close()
    } catch {
      // ignore
    }
  }
  servers.clear()
  routes.clear()
}

async function main() {
  const rl = readline.createInterface({ input: process.stdin })
  const first = await readLine(rl)
  let init
  try {
    init = JSON.parse(first)
  } catch {
    process.exit(1)
  }
  if (init.type !== 'initialize') {
    process.exit(2)
  }
  const workspace = init.workspace || process.cwd()
  const trusted = Boolean(init.trusted)

  await connectAll(workspace, trusted)
  const tools = exposeServerTools()

  send({
    type: 'register',
    commands: [{ name: 'mcp', description: 'Show MCP server connection status' }],
    tools
  })

  rl.on('line', (line) => {
    if (!line.trim()) return
    let message
    try {
      message = JSON.parse(line)
    } catch {
      return
    }
    if (message.type === 'shutdown') {
      shutdownAll().then(() => process.exit(0))
      return
    }
    if (message.type === 'tool') {
      handleTool(message).catch((error) => {
        send({
          type: 'response',
          id: message.id,
          content: [{ type: 'text', text: error.message }],
          is_error: true
        })
      })
      return
    }
    if (message.type === 'command' && message.name === 'mcp') {
      send({ type: 'response', id: message.id, message: mcpStatusText() })
      return
    }
    if (message.id !== undefined) {
      send({ type: 'response', id: message.id })
    }
  })

  rl.on('close', () => {
    shutdownAll().then(() => process.exit(0))
  })
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
