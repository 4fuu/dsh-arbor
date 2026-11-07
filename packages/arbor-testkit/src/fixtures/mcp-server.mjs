/**
 * A minimal MCP stdio server, for the dsh-arbor proofs.
 *
 * It speaks just enough of the Model Context Protocol for
 * `@deepseek-ai/dsh-mcp-client` to connect, list one tool and call it:
 * newline-delimited JSON-RPC 2.0 over stdin/stdout, `initialize`,
 * `notifications/initialized`, `tools/list` and `tools/call`. The protocol
 * version the client asks for is echoed back, which is what a server is meant
 * to do.
 *
 * It is a fixture, not a product: it exists so a proof can show a real
 * `mcp-client` row publishing a real `mcp__probe__echo` tool on `ctx.tools`,
 * which is what `/env` reads the DSH MCP server list off.
 */

/** The one tool this server publishes. */
const TOOL = {
  name: 'echo',
  description: 'Echo the text back. Fixture tool of the dsh-arbor MCP proof server.',
  inputSchema: {
    type: 'object',
    properties: { text: { type: 'string', description: 'the text to echo' } },
    required: ['text'],
    additionalProperties: false,
  },
}

/** One JSON-RPC reply, on one line. */
function reply(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`)
}

/** One JSON-RPC error, on one line. */
function fail(id, code, message) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } })}\n`)
}

/** One request's answer, or nothing when the request is a notification. */
function answer(message) {
  const { id, method, params } = message
  switch (method) {
    case 'initialize':
      return reply(id, {
        protocolVersion: params?.protocolVersion ?? '2025-11-25',
        capabilities: { tools: {} },
        serverInfo: { name: 'dsh-arbor-proof-mcp', version: '1.0.0' },
      })
    case 'ping':
      return reply(id, {})
    case 'tools/list':
      return reply(id, { tools: [TOOL] })
    case 'tools/call': {
      const text = typeof params?.arguments?.text === 'string' ? params.arguments.text : ''
      return reply(id, { content: [{ type: 'text', text: `echo: ${text}` }], isError: false })
    }
    case 'notifications/initialized':
    case 'notifications/cancelled':
      return undefined
    default:
      return id === undefined ? undefined : fail(id, -32601, `method not found: ${method}`)
  }
}

let buffer = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', chunk => {
  buffer += chunk
  for (;;) {
    const cut = buffer.indexOf('\n')
    if (cut < 0) return
    const line = buffer.slice(0, cut).trim()
    buffer = buffer.slice(cut + 1)
    if (line === '') continue
    let message
    try {
      message = JSON.parse(line)
    } catch {
      fail(null, -32700, 'parse error')
      continue
    }
    try {
      answer(message)
    } catch (error) {
      fail(message?.id ?? null, -32603, error instanceof Error ? error.message : String(error))
    }
  }
})
process.stdin.on('end', () => process.exit(0))
