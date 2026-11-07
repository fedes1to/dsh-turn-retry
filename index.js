/**
 * dsh-turn-retry — restart a turn that ended with an error.
 *
 * A failed turn is closed by the agent loop with
 * `turn/end { reason: { kind: 'error', error } }`. This plugin watches the
 * session feed for that exact closer and, after a configurable delay, injects
 * a synthetic follow-up message into the same agent. The follow-up opens a
 * fresh turn over the failed turn's history, so the model resumes the task
 * instead of the session sitting on an error card.
 *
 * The injected message carries a non-`user` source kind. dsh-TUI renders only
 * `source.kind === 'user'` prompts in the transcript, so the retry directive
 * reaches the model without adding a human bubble.
 *
 * The retry budget is per session and resets as soon as the session completes
 * a turn or a person sends a fresh prompt. Subagent sessions are skipped by
 * default: their parent already received the failure, so restarting them in
 * the background would be orphan work.
 *
 * @module dsh-turn-retry
 */

import { randomUUID } from 'node:crypto'

export const name = 'turn-retry'

/** The agent registry is where the retry message is injected. */
export const inject = ['agents']

/** Retries allowed after one failed turn before the plugin gives up. */
export const DEFAULT_MAX_RETRIES = 10

/** Delay before the first retry, in milliseconds. */
export const DEFAULT_DELAY_MS = 1000

/** Upper bound for the exponential delay, in milliseconds. */
export const DEFAULT_MAX_DELAY_MS = 30000

/** Multiplier applied to the delay after every failed retry. */
export const DEFAULT_BACKOFF = 2

/** Source kind of the injected message; anything but `user` stays hidden. */
export const DEFAULT_SOURCE_KIND = 'turn-retry'

/** What the model is told when a turn is restarted. */
export const DEFAULT_RETRY_TEXT =
  'The previous turn ended with an error before it could finish. Resume the same task from where it stopped; do not repeat work that already completed, and do not ask for confirmation.'

/**
 * Coerce a config value to a finite number at or above `minimum`.
 * @param {unknown} value - raw config value.
 * @param {number} fallback - value used when the input is unusable.
 * @param {number} minimum - smallest accepted value.
 * @returns {number} the coerced number.
 */
const asNumber = (value, fallback, minimum) => {
  const number =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && value.trim() !== ''
        ? Number(value)
        : Number.NaN
  return Number.isFinite(number) && number >= minimum ? number : fallback
}

/**
 * Coerce a config value to an integer at or above `minimum`.
 * @param {unknown} value - raw config value.
 * @param {number} fallback - value used when the input is unusable.
 * @param {number} minimum - smallest accepted value.
 * @returns {number} the coerced integer.
 */
const asInteger = (value, fallback, minimum) => Math.floor(asNumber(value, fallback, minimum))

/**
 * Coerce a config value to a non-empty string.
 * @param {unknown} value - raw config value.
 * @param {string} fallback - value used when the input is unusable.
 * @returns {string} the coerced string.
 */
const asText = (value, fallback) =>
  typeof value === 'string' && value.trim() !== '' ? value : fallback

/**
 * Wire the plugin.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - Cordis context.
 * @param {{
 *   maxRetries?: number,
 *   delayMs?: number,
 *   maxDelayMs?: number,
 *   backoff?: number,
 *   retryText?: string,
 *   sourceKind?: string,
 *   includeSubagents?: boolean,
 *   notices?: boolean,
 *   retryOnCodes?: string[],
 * }} [config] - Row config.
 */
export function apply(ctx, config = {}) {
  const maxRetries = asInteger(config.maxRetries, DEFAULT_MAX_RETRIES, 0)
  const baseDelayMs = asNumber(config.delayMs, DEFAULT_DELAY_MS, 0)
  const maxDelayMs = Math.max(baseDelayMs, asNumber(config.maxDelayMs, DEFAULT_MAX_DELAY_MS, 0))
  const backoff = Math.max(1, asNumber(config.backoff, DEFAULT_BACKOFF, 1))
  const retryText = asText(config.retryText, DEFAULT_RETRY_TEXT)
  const sourceKind = asText(config.sourceKind, DEFAULT_SOURCE_KIND)
  const includeSubagents = config.includeSubagents === true
  const notices = config.notices !== false
  const retryOnCodes =
    Array.isArray(config.retryOnCodes) && config.retryOnCodes.length > 0
      ? new Set(config.retryOnCodes.filter((code) => typeof code === 'string' && code !== ''))
      : undefined

  /**
   * Per-session retry bookkeeping.
   * @type {Map<string, {
   *   attempts: number,
   *   pending: boolean,
   *   timer: ReturnType<typeof setTimeout> | undefined,
   *   generation: number,
   *   failure: { message?: string, code?: string } | undefined,
   * }>}
   */
  const sessions = new Map()

  /**
   * The bookkeeping record for one session.
   * @param {string} id - session id.
   */
  const stateOf = (id) => {
    let state = sessions.get(id)
    if (state === undefined) {
      state = { attempts: 0, pending: false, timer: undefined, generation: 0, failure: undefined }
      sessions.set(id, state)
    }
    return state
  }

  /**
   * Drop a pending retry and reset the budget. Bumping the generation makes
   * an already-resolved `whenIdle()` callback a no-op.
   * @param {string} id - session id.
   */
  const forget = (id) => {
    const state = sessions.get(id)
    if (state === undefined) return
    state.generation += 1
    state.pending = false
    state.attempts = 0
    state.failure = undefined
    if (state.timer !== undefined) {
      clearTimeout(state.timer)
      state.timer = undefined
    }
  }

  /**
   * Forget one session entirely.
   * @param {string} id - session id.
   */
  const remove = (id) => {
    forget(id)
    sessions.delete(id)
  }

  /**
   * Show a transient notice when the host exposes the toast seam.
   * @param {string} text - toast text.
   * @param {'success' | 'warning' | 'error'} color - toast color.
   */
  const notify = (text, color) => {
    if (!notices) return
    try {
      const toast = typeof ctx.get === 'function' ? ctx.get('tuiToast') : undefined
      toast?.show?.(text, { color, timeoutMs: 4000 })
    } catch {
      // A toast must never take the plugin down.
    }
  }

  /**
   * Build the model-facing message that restarts the turn.
   * @param {{ message?: string } | undefined} failure - the turn's failure facts.
   */
  const buildMessage = (failure) => {
    const error = typeof failure?.message === 'string' ? failure.message : ''
    const text = retryText.includes('{error}') ? retryText.split('{error}').join(error) : retryText
    return {
      id: randomUUID(),
      role: 'user',
      content: [{ type: 'text', text }],
      source: { kind: sourceKind },
    }
  }

  /**
   * Deliver the pending retry for one session, if it is still current.
   * @param {string} id - session id.
   * @param {number} generation - generation captured when the retry was armed.
   */
  const deliver = (id, generation) => {
    const state = sessions.get(id)
    if (state === undefined || state.generation !== generation || !state.pending) return
    const agent = ctx.agents?.get(id)
    if (agent === undefined || typeof agent.followup !== 'function') {
      state.pending = false
      return
    }

    const restart = () => {
      const current = sessions.get(id)
      if (current === undefined || current.generation !== generation || !current.pending) return
      const live = ctx.agents?.get(id)
      if (live === undefined || typeof live.followup !== 'function') {
        current.pending = false
        return
      }
      current.pending = false
      try {
        live.followup(buildMessage(current.failure))
      } catch (error) {
        ctx.logger?.warn?.(`turn-retry: could not restart session ${id}: ${String(error)}`)
      }
    }

    if (agent.status === 'running' && typeof agent.whenIdle === 'function') {
      // The driver is still closing the failed turn, or already running work
      // that arrived after it. Deliver once the agent is quiescent, unless a
      // completion, cancellation, or a newer human prompt reset this retry.
      Promise.resolve(agent.whenIdle())
        .then(restart)
        .catch(() => {
          const current = sessions.get(id)
          if (current !== undefined && current.generation === generation) current.pending = false
        })
      return
    }

    restart()
  }

  /**
   * Arm one retry for a session whose turn ended with an error.
   * @param {import('@deepseek-ai/dsh-session').Session} session - the failed session.
   * @param {{ message?: string, code?: string } | undefined} failure - failure facts.
   */
  const schedule = (session, failure) => {
    const id = session.id
    const state = stateOf(id)
    if (state.pending) return
    if (state.attempts >= maxRetries) {
      notify(`↻ turn retry: gave up after ${maxRetries} ${maxRetries === 1 ? 'retry' : 'retries'}`, 'error')
      return
    }
    const agent = ctx.agents?.get(id)
    if (agent === undefined || typeof agent.followup !== 'function') return

    state.attempts += 1
    state.pending = true
    state.failure = failure
    const attempt = state.attempts
    const generation = state.generation
    const delay = Math.min(maxDelayMs, Math.round(baseDelayMs * Math.pow(backoff, attempt - 1)))

    state.timer = setTimeout(() => {
      state.timer = undefined
      deliver(id, generation)
    }, delay)
    // Never keep a shutting-down process alive for a retry.
    state.timer.unref?.()

    notify(`↻ turn failed — retry ${attempt}/${maxRetries} in ${delay}ms`, 'warning')
  }

  /**
   * The session feed: turn closers arm or clear retries, human prompts reset.
   * @param {import('@deepseek-ai/dsh-session').Session} session - the session whose log grew.
   * @param {import('@deepseek-ai/dsh-session').SessionEvent} event - the appended event.
   */
  const onSessionEvent = (session, event) => {
    if (session === undefined || event === undefined) return
    const id = session.id

    if (event.type === 'turn/end') {
      const reason = event.data?.reason
      if (reason?.kind === 'error') {
        if (!includeSubagents && session.header?.origin === 'subagent') return
        const code = reason.error?.code
        if (retryOnCodes !== undefined && !retryOnCodes.has(code)) return
        schedule(session, reason.error)
      } else if (reason?.kind === 'completed' || reason?.kind === 'aborted') {
        forget(id)
      }
      return
    }

    if (event.type === 'user/message' && event.data?.source?.kind === 'user') {
      // A fresh human prompt supersedes a pending automatic retry.
      forget(id)
    }
  }

  ctx.on('session/event', onSessionEvent)
  ctx.on('session/disposed', (session) => remove(session.id))
  ctx.on('agent/disposed', ({ agent }) => remove(agent.session.id))

  ctx.effect(() => () => {
    for (const id of [...sessions.keys()]) remove(id)
  })
}
