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
 * fake agent registry, and the toast feed.
 */
function mount(config, options = {}) {
  const handlers = new Map()
  const agents = new Map()
  const cleanups = []
  const toasts = []

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

  return { ctx, handlers, emit, agents, addAgent, toasts, cleanups }
}

const session = (id, origin) => ({ id, header: origin === undefined ? {} : { origin } })

const turnEnd = (kind, error) => ({
  type: 'turn/end',
  data: { turn: 1, reason: kind === 'error' ? { kind, error } : { kind } },
})

const userMessage = (kind = 'user') => ({
  type: 'user/message',
  data: { source: { kind } },
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

// Subagent sessions are skipped unless explicitly included.
{
  const { emit, addAgent } = mount({ delayMs: 0, backoff: 1 })
  const agent = addAgent('s1')
  emit('session/event', session('s1', 'subagent'), turnEnd('error', { code: 'SERVER', message: 'boom' }))
  await tick()
  assert.equal(agent.calls.length, 0)
}
{
  const { emit, addAgent } = mount({ delayMs: 0, backoff: 1, includeSubagents: true })
  const agent = addAgent('s1')
  emit('session/event', session('s1', 'subagent'), turnEnd('error', { code: 'SERVER', message: 'boom' }))
  await tick()
  assert.equal(agent.calls.length, 1)
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

console.log('ok — turn-retry restarts failed turns within the configured budget')
