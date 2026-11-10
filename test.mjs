import assert from 'node:assert/strict'
import {
  apply,
  DEFAULT_MAX_RETRIES,
  DEFAULT_RETRY_TEXT,
  DEFAULT_SOURCE_KIND,
} from './index.js'

const tick = (ms = 10) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Mount the plugin on a fake context and return the recorded handlers, the
 * fake agent registry, the toast feed, and the fake compaction engine.
 *
 * `options.compaction` replaces the default fake engine (which records calls
 * and resolves); pass `null` to mount a host without a compaction service.
 */
function mount(config, options = {}) {
  const handlers = new Map()
  const agents = new Map()
  const cleanups = []
  const toasts = []
  const compactions = []

  const compaction =
    options.compaction === undefined
      ? {
          compactNow(agent, signal) {
            compactions.push({ agent, signal })
            return Promise.resolve({})
          },
        }
      : options.compaction

  const ctx = {
    on(event, handler) {
      handlers.set(event, handler)
      return () => handlers.delete(event)
    },
    effect(fn) {
      cleanups.push(fn())
    },
    agents: {
      get(id) {
        return agents.get(id)
      },
    },
    get(name) {
      if (name === 'tuiToast') {
        return { show: (text, opts) => toasts.push({ text, ...opts }) }
      }
      if (name === 'compaction') return compaction ?? undefined
      return undefined
    },
    logger: { warn() {} },
  }

  apply(ctx, config)

  const emit = (event, ...args) => handlers.get(event)?.(...args)

  const addAgent = (id, overrides = {}) => {
    const record = {
      status: 'idle',
      calls: [],
      followup(message) {
        record.calls.push(message)
      },
      whenIdle() {
        return Promise.resolve()
      },
      ...overrides,
    }
    agents.set(id, record)
    return record
  }

  return { ctx, handlers, emit, agents, addAgent, toasts, cleanups, compactions }
}

const session = (id, header = {}) => ({ id, header })

const subagentSession = (id) => session(id, { origin: 'subagent', parentSession: 'parent' })

const forkSession = (id) => session(id, { parentSession: 'parent' })

const turnEnd = (kind, error) => ({
  type: 'turn/end',
  data: { turn: 1, reason: kind === 'error' ? { kind, error } : { kind } },
})

const userMessage = (kind = 'user') => ({
  type: 'user/message',
  data: { source: { kind } },
})

const compactEnd = (turn, error) => ({
  type: 'compaction/end',
  data: { compactionId: 'c1', turn, ...(error === undefined ? {} : { error }) },
})

// The default budget is 10 retries.
assert.equal(DEFAULT_MAX_RETRIES, 10)

// A failed turn is restarted with a hidden, model-facing message.
{
  const { emit, addAgent } = mount({ delayMs: 0, backoff: 1 })
  const agent = addAgent('s1')
  emit('session/event', session('s1'), turnEnd('error', { code: 'SERVER', message: 'boom' }))
  assert.equal(agent.calls.length, 0, 'the retry is scheduled, not immediate')
  await tick()
  assert.equal(agent.calls.length, 1)
  const message = agent.calls[0]
  assert.equal(message.role, 'user')
  assert.equal(message.content[0].text, DEFAULT_RETRY_TEXT)
  assert.equal(message.source.kind, DEFAULT_SOURCE_KIND)
  assert.notEqual(message.source.kind, 'user')
  assert.equal(typeof message.id, 'string')
}

// `retryText` is configurable and expands `{error}`.
{
  const { emit, addAgent } = mount({ delayMs: 0, backoff: 1, retryText: 'Retry: {error}' })
  const agent = addAgent('s1')
  emit('session/event', session('s1'), turnEnd('error', { code: 'SERVER', message: 'boom' }))
  await tick()
  assert.equal(agent.calls[0].content[0].text, 'Retry: boom')
}

// The retry budget is enforced and configurable.
{
  const { emit, addAgent } = mount({ delayMs: 0, backoff: 1, maxRetries: 2 })
  const agent = addAgent('s1')
  for (let index = 0; index < 5; index += 1) {
    emit('session/event', session('s1'), turnEnd('error', { code: 'SERVER', message: 'boom' }))
    await tick()
  }
  assert.equal(agent.calls.length, 2)
}

// A completed turn resets the budget.
{
  const { emit, addAgent } = mount({ delayMs: 0, backoff: 1, maxRetries: 1 })
  const agent = addAgent('s1')
  emit('session/event', session('s1'), turnEnd('error', { code: 'SERVER', message: 'boom' }))
  await tick()
  assert.equal(agent.calls.length, 1)
  emit('session/event', session('s1'), turnEnd('completed'))
  emit('session/event', session('s1'), turnEnd('error', { code: 'SERVER', message: 'boom' }))
  await tick()
  assert.equal(agent.calls.length, 2)
}

// A fresh human prompt cancels a pending retry.
{
  const { emit, addAgent } = mount({ delayMs: 50, backoff: 1 })
  const agent = addAgent('s1')
  emit('session/event', session('s1'), turnEnd('error', { code: 'SERVER', message: 'boom' }))
  emit('session/event', session('s1'), userMessage('user'))
  await tick(80)
  assert.equal(agent.calls.length, 0)
}

// A peer (agent-message) prompt also supersedes a pending retry.
{
  const { emit, addAgent } = mount({ delayMs: 50, backoff: 1 })
  const agent = addAgent('s1')
  emit('session/event', session('s1'), turnEnd('error', { code: 'SERVER', message: 'boom' }))
  emit('session/event', session('s1'), userMessage('agent-message'))
  await tick(80)
  assert.equal(agent.calls.length, 0)
}

// The plugin's own synthetic message does not cancel the retry.
{
  const { emit, addAgent } = mount({ delayMs: 20, backoff: 1 })
  const agent = addAgent('s1')
  emit('session/event', session('s1'), turnEnd('error', { code: 'SERVER', message: 'boom' }))
  emit('session/event', session('s1'), userMessage(DEFAULT_SOURCE_KIND))
  await tick(40)
  assert.equal(agent.calls.length, 1)
}

// A cancelled turn clears the budget instead of retrying.
{
  const { emit, addAgent } = mount({ delayMs: 0, backoff: 1 })
  const agent = addAgent('s1')
  emit('session/event', session('s1'), turnEnd('aborted'))
  await tick()
  assert.equal(agent.calls.length, 0)
}

// ── delegated children ──────────────────────────────────────────────────────
// A failed subagent turn is retried by default, and immediately: the child
// settles and is disposed as soon as it goes idle, so the configured delay must
// not be applied.
{
  const { emit, addAgent } = mount({ delayMs: 5000, backoff: 1 })
  const agent = addAgent('s1', { status: 'running', whenIdle: () => Promise.resolve() })
  emit('session/event', subagentSession('s1'), turnEnd('error', { code: 'SERVER', message: 'boom' }))
  await tick(0)
  assert.equal(agent.calls.length, 1)
  assert.equal(agent.calls[0].source.kind, DEFAULT_SOURCE_KIND)
}

// A fork child (lineage without the subagent origin) is a delegated child too.
{
  const { emit, addAgent } = mount({ delayMs: 5000, backoff: 1 })
  const agent = addAgent('s1', { status: 'running', whenIdle: () => Promise.resolve() })
  emit('session/event', forkSession('s1'), turnEnd('error', { code: 'SERVER', message: 'boom' }))
  await tick(0)
  assert.equal(agent.calls.length, 1)
}

// `includeSubagents: false` restores the skip.
{
  const { emit, addAgent } = mount({ delayMs: 0, backoff: 1, includeSubagents: false })
  const agent = addAgent('s1')
  emit('session/event', subagentSession('s1'), turnEnd('error', { code: 'SERVER', message: 'boom' }))
  await tick()
  assert.equal(agent.calls.length, 0)
}

// The subagent budget is enforced and resets on a completed child turn.
{
  const { emit, addAgent } = mount({ delayMs: 5000, backoff: 1, maxRetries: 1 })
  const agent = addAgent('s1', { status: 'running', whenIdle: () => Promise.resolve() })
  const sub = subagentSession('s1')
  emit('session/event', sub, turnEnd('error', { code: 'SERVER', message: 'boom' }))
  await tick(0)
  assert.equal(agent.calls.length, 1)
  emit('session/event', sub, turnEnd('completed'))
  emit('session/event', sub, turnEnd('error', { code: 'SERVER', message: 'boom' }))
  await tick(0)
  assert.equal(agent.calls.length, 2)
}

// A child that settled and was disposed before delivery is left alone.
{
  const { emit, addAgent, agents } = mount({ delayMs: 5000, backoff: 1 })
  const agent = addAgent('s1', { status: 'running', whenIdle: () => Promise.resolve() })
  emit('session/event', subagentSession('s1'), turnEnd('error', { code: 'SERVER', message: 'boom' }))
  agents.delete('s1')
  await tick(0)
  assert.equal(agent.calls.length, 0)
}

// `retryOnCodes` narrows which failures restart the turn.
{
  const { emit, addAgent } = mount({ delayMs: 0, backoff: 1, retryOnCodes: ['RATE_LIMIT'] })
  const agent = addAgent('s1')
  emit('session/event', session('s1'), turnEnd('error', { code: 'AUTH', message: 'no' }))
  await tick()
  assert.equal(agent.calls.length, 0)
  emit('session/event', session('s1'), turnEnd('error', { code: 'RATE_LIMIT', message: 'slow' }))
  await tick()
  assert.equal(agent.calls.length, 1)
}

// A running agent waits for quiescence before the retry is delivered.
{
  let release
  const idle = new Promise((resolve) => {
    release = resolve
  })
  const { emit, addAgent } = mount({ delayMs: 0, backoff: 1 })
  const agent = addAgent('s1', { status: 'running', whenIdle: () => idle })
  emit('session/event', session('s1'), turnEnd('error', { code: 'SERVER', message: 'boom' }))
  await tick()
  assert.equal(agent.calls.length, 0)
  agent.status = 'idle'
  release()
  await tick()
  assert.equal(agent.calls.length, 1)
}

// A session without a live agent is left alone rather than throwing.
{
  const { emit } = mount({ delayMs: 0, backoff: 1 })
  emit('session/event', session('s1'), turnEnd('error', { code: 'SERVER', message: 'boom' }))
  await tick()
}

// Disposal clears pending timers.
{
  const { emit, addAgent, cleanups } = mount({ delayMs: 50, backoff: 1 })
  const agent = addAgent('s1')
  emit('session/event', session('s1'), turnEnd('error', { code: 'SERVER', message: 'boom' }))
  for (const cleanup of cleanups) cleanup()
  await tick(80)
  assert.equal(agent.calls.length, 0)
}

// Malformed payloads are ignored rather than thrown.
{
  const { emit } = mount()
  assert.doesNotThrow(() => {
    emit('session/event', undefined, undefined)
    emit('session/event', session('s1'), {})
    emit('session/event', session('s1'), { type: 'turn/end', data: {} })
    emit('session/event', session('s1'), { type: 'turn/end', data: { reason: { kind: 'error' } } })
    emit('session/event', session('s1'), { type: 'compaction/end', data: {} })
  })
}

// A zero budget gives up immediately and says so.
{
  const { emit, addAgent, toasts } = mount({ delayMs: 0, backoff: 1, maxRetries: 0 })
  addAgent('s1')
  emit('session/event', session('s1'), turnEnd('error', { code: 'SERVER', message: 'boom' }))
  assert.ok(toasts.some((toast) => toast.text.includes('gave up')))
}

// Notices can be switched off.
{
  const { emit, addAgent, toasts } = mount({ delayMs: 0, backoff: 1, notices: false })
  addAgent('s1')
  emit('session/event', session('s1'), turnEnd('error', { code: 'SERVER', message: 'boom' }))
  await tick()
  assert.equal(toasts.length, 0)
}

// ── compaction ──────────────────────────────────────────────────────────────
// A turn-owned compaction failure is the turn path's business: it must not
// inject a follow-up of its own (that would duplicate the turn retry or invent
// a turn that never failed) and must not re-run the compaction.
{
  const { emit, addAgent, compactions } = mount({ delayMs: 0, backoff: 1 })
  const agent = addAgent('s1')
  emit('session/event', session('s1'), compactEnd(3, 'summarizer exploded'))
  await tick()
  assert.equal(agent.calls.length, 0)
  assert.equal(compactions.length, 0)
}

// A standalone compaction that closed with an error is re-run through the
// compaction service, not restarted as a model turn.
{
  const { emit, addAgent, compactions } = mount({ delayMs: 0, backoff: 1 })
  const agent = addAgent('s1')
  emit('session/event', session('s1'), compactEnd(null, 'summarizer exploded'))
  assert.equal(compactions.length, 0, 'the retry is scheduled, not immediate')
  await tick()
  assert.equal(compactions.length, 1)
  assert.equal(compactions[0].agent, agent)
  assert.equal(agent.calls.length, 0)
}

// A committed standalone compaction is not retried.
{
  const { emit, addAgent, compactions } = mount({ delayMs: 0, backoff: 1 })
  addAgent('s1')
  emit('session/event', session('s1'), compactEnd(null))
  await tick()
  assert.equal(compactions.length, 0)
}

// A cancelled standalone compaction is a decision, not a failure to retry.
{
  const { emit, addAgent, compactions } = mount({ delayMs: 0, backoff: 1 })
  addAgent('s1')
  emit('session/event', session('s1'), compactEnd(null, 'This operation was aborted'))
  await tick()
  assert.equal(compactions.length, 0)
}

// The compaction budget is separate and capped.
{
  let calls = 0
  const compaction = {
    compactNow() {
      calls += 1
      return Promise.reject(new Error('still failing'))
    },
  }
  const { emit, addAgent, toasts } = mount(
    { delayMs: 0, backoff: 1, maxRetries: 2 },
    { compaction },
  )
  addAgent('s1')
  emit('session/event', session('s1'), compactEnd(null, 'boom'))
  await tick(50)
  assert.equal(calls, 2)
  assert.ok(toasts.some((toast) => toast.text.includes('compaction retry: gave up')))
}

// A committed compaction resets the compaction budget.
{
  const pending = []
  const compaction = {
    compactNow() {
      return new Promise((resolve, reject) => {
        pending.push({ resolve, reject })
      })
    },
  }
  const { emit, addAgent } = mount({ delayMs: 0, backoff: 1, maxRetries: 1 }, { compaction })
  addAgent('s1')
  emit('session/event', session('s1'), compactEnd(null, 'boom'))
  await tick()
  assert.equal(pending.length, 1, 'the first attempt runs')
  pending[0].resolve({})
  await tick()
  // The next failure starts a fresh budget: attempt 1 runs again instead of
  // immediately exhausting maxRetries.
  emit('session/event', session('s1'), compactEnd(null, 'boom'))
  await tick()
  assert.equal(pending.length, 2)
}

// A committed compaction cancels a retry that is still waiting to run.
{
  const { emit, addAgent, compactions } = mount({ delayMs: 50, backoff: 1 })
  addAgent('s1')
  emit('session/event', session('s1'), compactEnd(null, 'boom'))
  emit('session/event', session('s1'), compactEnd(null))
  await tick(80)
  assert.equal(compactions.length, 0)
}

// The re-run's own bracket events do not arm a second retry.
{
  const pending = []
  const compaction = {
    compactNow() {
      return new Promise((resolve, reject) => {
        pending.push({ resolve, reject })
      })
    },
  }
  const { emit, addAgent } = mount({ delayMs: 0, backoff: 1 }, { compaction })
  addAgent('s1')
  emit('session/event', session('s1'), compactEnd(null, 'boom'))
  await tick()
  assert.equal(pending.length, 1)
  emit('session/event', session('s1'), { type: 'compaction/start', data: {} })
  emit('session/event', session('s1'), compactEnd(null, 'boom again'))
  await tick()
  assert.equal(pending.length, 1)
  pending[0].resolve({})
  await tick()
  assert.equal(pending.length, 1)
}

// A fresh human prompt cancels a pending compaction retry and resets its budget.
{
  const { emit, addAgent, compactions } = mount({ delayMs: 50, backoff: 1 })
  addAgent('s1')
  emit('session/event', session('s1'), compactEnd(null, 'boom'))
  emit('session/event', session('s1'), userMessage('user'))
  await tick(80)
  assert.equal(compactions.length, 0)
}

// `includeCompaction: false` disables the compaction path without touching the
// turn path.
{
  const { emit, addAgent, compactions } = mount({
    delayMs: 0,
    backoff: 1,
    includeCompaction: false,
  })
  const agent = addAgent('s1')
  emit('session/event', session('s1'), compactEnd(null, 'boom'))
  await tick()
  assert.equal(compactions.length, 0)
  emit('session/event', session('s1'), turnEnd('error', { code: 'SERVER', message: 'boom' }))
  await tick()
  assert.equal(agent.calls.length, 1, 'the turn path still retries')
}

// A busy agent is not compacted underneath its running turn.
{
  const { emit, addAgent, compactions } = mount({ delayMs: 0, backoff: 1 })
  addAgent('s1', { status: 'running' })
  emit('session/event', session('s1'), compactEnd(null, 'boom'))
  await tick()
  assert.equal(compactions.length, 0)
}

// A host without a compaction service is left alone rather than throwing.
{
  const { emit, addAgent } = mount({ delayMs: 0, backoff: 1 }, { compaction: null })
  addAgent('s1')
  emit('session/event', session('s1'), compactEnd(null, 'boom'))
  await tick()
}

// A subagent compaction is skipped with `includeSubagents: false`.
{
  const { emit, addAgent, compactions } = mount({
    delayMs: 0,
    backoff: 1,
    includeSubagents: false,
  })
  addAgent('sub')
  emit('session/event', subagentSession('sub'), compactEnd(null, 'boom'))
  await tick()
  assert.equal(compactions.length, 0)
}

console.log(
  'ok — turn-retry restarts failed turns (including delegated children) and re-runs failed standalone compactions',
)
