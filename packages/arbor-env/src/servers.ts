/**
 * DSH's MCP servers, as arbor's environment sees them.
 *
 * DSH has no MCP registry service to ask: an MCP server is a `mcp-client`
 * plugin row, and what it publishes is its tools on `ctx.tools` under the
 * server-qualified public name `mcp__<serverName>__<rawName>`
 * (`@deepseek-ai/dsh-mcp-client`, `lib/index.js`, `publicToolName`; the config's
 * `serverName` must match `[A-Za-z0-9_-]{1,32}`, so the segment between the
 * first `mcp__` and the next `__` is always the server's own name). It also
 * contributes one system-prompt section named `mcp:<serverName>`
 * (`registerServerContext`), which is third-party content the prompt bridge
 * carries into `<dsh>`.
 *
 * So the server list is read off the tool names, which is the same thing the
 * tool bridge bridges: a DSH MCP tool arrives in arbor as an external tool with
 * that name, and it is never restated as an arbor MCP module. The item listed
 * here therefore declares no functions — an arbor MCP module would give the
 * model a second way to call the same tool, which is exactly what must not
 * happen.
 */

/** One DSH MCP server, as this package lists it. */
export interface DshServer {
  readonly name: string
  /** The public names of the tools this server published, as DSH names them. */
  readonly tools: readonly string[]
}

/** The public-name prefix every DSH MCP tool carries. */
const MCP_PREFIX = 'mcp__'

/**
 * The server name one public tool name carries, or `undefined` when the name is
 * not an MCP tool's.
 *
 * The server's own name is `[A-Za-z0-9_-]{1,32}` by config, so the first `__`
 * after the prefix ends it — including in the lossy-normalized case, where a
 * hash is appended after the raw name rather than inside the server's segment.
 */
export function serverOfToolName(name: string): string | undefined {
  if (!name.startsWith(MCP_PREFIX)) return undefined
  const rest = name.slice(MCP_PREFIX.length)
  const cut = rest.indexOf('__')
  if (cut <= 0) return undefined
  return rest.slice(0, cut)
}

/** Every MCP server the named DSH tools belong to, by server name. */
export function serversOfToolNames(names: readonly string[]): readonly DshServer[] {
  const byServer = new Map<string, string[]>()
  for (const name of names) {
    const server = serverOfToolName(name)
    if (server === undefined) continue
    byServer.set(server, [...(byServer.get(server) ?? []), name])
  }
  return [...byServer]
    .map(([name, tools]) => ({ name, tools: tools.sort() }))
    .sort((left, right) => left.name.localeCompare(right.name))
}
