/**
 * Proof 25: the DSH backend session's own state, apart from the host's record.
 *
 * A window opens idle because opening it starts no run. The state is the
 * backend session's, not a copy of the host's window record: a context delivery
 * never wakes it, an input delivery to an idle window becomes the next turn's
 * input, and the same delivery while a run is in progress goes in at the next
 * step. The run's end returns the session to idle, and an ended window drops
 * deliveries. This is the field whose old "opened means running" default made a
 * quiet window look busy and whose copying of the host's idle would drop every
 * delivery.
 *
 * Run: pnpm proof:backend-session
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Delivery } from '@4fu/arbor-interfaces'
import { createDshBackend } from '@4fu/dsh-arbor-llm'
import { finishProof } from '../packages/arbor-testkit/src/index.ts'

const failures: string[] = []
const check = (label: string, ok: boolean, detail: string): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}: ${detail}`)
  if (!ok) failures.push(label)
}

/** Every delivery method the backend called on the fake agent, in order. */
const calls: string[] = []

const agent = {
  status: 'idle',
  inject: () => { calls.push('inject') },
  steer: () => { calls.push('steer') },
  followup: () => { calls.push('followup') },
} as unknown as Agent

/** One delivery whose rendered text is irrelevant to the state under test. */
function delivery(role: Delivery['role'], kind: Delivery['kind'] = 'inserted_task'): Delivery {
  return {
    kind,
    role,
    refs: [],
    time: Date.now(),
    content: [{ kind: 'data', fields: { content: 'delivery' } }],
  }
}

async function main(): Promise<void> {
  const backend = createDshBackend({
    llm: {} as never,
    tools: {} as never,
    agents: {} as never,
    renderer: () => ({ render: () => 'delivery' } as never),
  })
  const session = await backend.open({
    window: 'c1' as never,
    task: 't1' as never,
    prompt: { system: '', memory: '', envRevision: '' },
    tools: [],
    modules: [],
    model: 'model',
    limits: { contextTokens: 1_000, reserveTokens: 100, idleSeconds: 300 },
  })
  backend.bind('c1' as never, agent)

  check('a freshly opened window is idle', session.state === 'idle', `state=${session.state}`)

  await session.steer(delivery('context', 'tools_delta'))
  check('context is injected and never starts a turn', calls.join(',') === 'inject', `calls=${calls.join(',')}`)

  calls.length = 0
  await session.steer(delivery('input'))
  check('an input steered into an idle window is its next turn',
    calls.join(',') === 'followup' && session.state === 'idle',
    `calls=${calls.join(',')} state=${session.state}`)

  calls.length = 0
  backend.publish('c1' as never, { kind: 'text_delta', delta: 'working' })
  check('a run event makes the session running', session.state === 'running', `state=${session.state}`)
  await session.steer(delivery('input'))
  check('an input steered during a run goes in at the next step', calls.join(',') === 'steer', `calls=${calls.join(',')}`)

  calls.length = 0
  await session.followUp(delivery('input'))
  check('a follow-up stays after the run', calls.join(',') === 'followup', `calls=${calls.join(',')}`)

  backend.finishRun('c1' as never)
  check('the run end returns the session to idle', session.state === 'idle', `state=${session.state}`)

  calls.length = 0
  await session.steer(delivery('input'))
  check('a new idle input starts the next turn again', calls.join(',') === 'followup', `calls=${calls.join(',')}`)

  await session.end()
  calls.length = 0
  await session.steer(delivery('input'))
  await session.followUp(delivery('input'))
  check('an ended window drops deliveries', calls.length === 0 && session.state === 'ended',
    `calls=${calls.join(',')} state=${session.state}`)
}

try {
  await main()
} catch (error: unknown) {
  console.error(error)
  failures.push(`exception: ${error instanceof Error ? error.message : String(error)}`)
} finally {
  finishProof('PROOF 25', failures)
}
