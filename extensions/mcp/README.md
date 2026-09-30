# MCP extension

Connect local stdio and remote HTTP MCP servers to niminal so the model can call their tools like any other extension tool.

## Quickstart

Install the extension and its Node dependency:

```bash
cp -r extensions/mcp ~/.niminal/extensions/
cd ~/.niminal/extensions/mcp
npm install
```

Add a local server to `~/.niminal/mcp.json`:

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"]
    }
  }
}
```

Restart niminal or run `/reload`. Check status with `/mcp`.

### Remote server

Use a `url` (and optional `headers`) for hosted MCP endpoints:

```json
{
  "mcpServers": {
    "my-service": {
      "url": "https://mcp.example.com/mcp",
      "headers": {
        "Authorization": "Bearer ${env:MY_SERVICE_TOKEN}"
      }
    }
  }
}
```

Set `MY_SERVICE_TOKEN` in your shell before starting niminal. If you omit `type`, the extension tries Streamable HTTP first, then legacy SSE.

## Configuration

niminal reads `mcpServers` from these files, in order. Later files replace a server when the name matches:

```text
~/.agents/mcp.json
~/.niminal/mcp.json
<workspace>/.agents/mcp.json
<workspace>/.niminal/mcp.json
```

Project files load only when the workspace is trusted, because stdio servers run commands on your machine.

Each server entry uses the same shape as other MCP clients:

| Field | Purpose |
| --- | --- |
| `command` | Executable for stdio transport (required for local servers) |
| `args` | Arguments passed to the command |
| `env` | Extra environment variables |
| `cwd` | Working directory for the server process |
| `url` | MCP endpoint for remote servers (required when not using `command`) |
| `headers` | HTTP headers for remote servers (for example `Authorization`) |
| `type` | Remote transport: `http` (Streamable HTTP), `sse` (legacy), or omit to auto-detect |
| `enabled` | Set to `false` to keep the entry without connecting |
| `capabilities` | niminal approval hints: `read`, `write`, `shell`, `network`, `user` |

In `url` and header values you can use `${env:VAR_NAME}` to read from the environment. If a referenced variable is unset, that server fails to connect and `/mcp` shows the error.

If you omit `capabilities`, every tool from that server defaults to `network` and prompts in the TUI.

## Tool names

Tools are exposed as `{server}__{tool}`. For example, a `read_file` tool on the `filesystem` server is `filesystem__read_file`.

## Status and failures

Run `/mcp` to see each configured server, transport (`stdio`, `http`, or `sse`), how many tools connected, the registered tool names, and any errors.

Servers connect independently. If one server fails, the others still register their tools.

## Limitations

- tools only (no MCP resources or prompts)
- remote auth via static headers only (no OAuth flow)
- servers stay connected when you start a new session, so run `/reload` after you change `mcp.json`; a new session reuses the connections it already has

## Next steps

- [Permissions](https://niminal.dev/guides/permissions/) for approval behavior
- [Extensions and hooks](https://niminal.dev/guides/extensions-and-hooks/) for the extension protocol
