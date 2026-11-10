# dsh-turn-retry

A dsh plugin that **restarts a turn that ended with an error**, with a
configurable retry budget (default: 10).

```text
turn fails  →  plugin waits  →  injects a hidden follow-up  →  the model resumes
```

The retry message is model-facing only: it carries a non-`user` source kind,
so dsh-TUI does not render it as a human prompt. The failed turn's error card
stays in the transcript; the next assistant output simply follows it.

## How it works

1. The agent loop closes a failed turn with
   `turn/end { reason: { kind: 'error', error } }`.
2. The plugin watches the session feed (`session/event`) for that closer and,
   after a delay, injects a follow-up into the same agent:

   ```js
   agent.followup({
     id, role: 'user',
     content: [{ type: 'text', text: retryText }],
     source: { kind: 'turn-retry' },
   })
   ```

3. The follow-up opens a fresh turn over the failed turn's history, so the
   model continues the task instead of the session sitting on an error.
4. The budget resets when the session completes a turn or a person sends a
   fresh prompt.

### Delegated children (subagents, forks, Agent Teams teammates)

Delegated children are retried too, and **immediately** rather than after
`delayMs`. A child settles and is disposed as soon as it goes idle, so a delayed
retry would find no live agent and the delegation would be lost. Delivering
while the failed turn is still closing keeps the child resident, so the parent
observes the eventual outcome — or the final failure once the budget is
exhausted — instead of an intermediate error. Set `includeSubagents: false` to
keep the old skip-the-child behaviour.

## Compactions

A compaction is **not** a turn, so the `turn/end` watcher never fires for it.
The host brackets every compaction with `compaction/start` and `compaction/end`,
and a failed close records `error` on the end event.

A **turn-owned** compaction failure is already covered by the turn retry: a
pressure-compaction failure is caught by the host and the turn continues, and an
overflow-recovery failure ends the turn with an error, which the turn retry
restarts. The plugin leaves those alone — a second follow-up would duplicate the
retry or invent a turn that never failed.

A **standalone** (manual `/compact`) compaction failure is retried by re-running
the compaction through the compaction service (`ctx.compaction.compactNow`), not
by injecting a model turn: a model turn would not compact a session below the
automatic threshold, and it would claim a failed turn that never existed. The
compaction path carries its **own** budget; a committed compaction or a fresh
human prompt resets it, while a completed turn does not, so a permanently
failing summarizer cannot loop forever. A cancellation is not retried.
`includeCompaction: false` turns the whole path off.

## Install

```sh
dsh plugin --profile <profile> add git+<repository-url>
```

Then restart the profile. The package declares `dsh.bundle.patch`, so
`dsh plugin add` also appends it to `dsh.profile.bundles`.

No grants are required: the plugin listens to the kernel session feed and
injects through the public agent API.

## Configure

Override the row by id in the profile's `cordis.patch.yml` user layer — never
insert a second same-id row:

```yaml
- id: turn-retry
  config:
    maxRetries: 10
    delayMs: 1000
    maxDelayMs: 30000
    backoff: 2
    retryText: 'The previous turn ended with an error…'
    sourceKind: turn-retry
    includeSubagents: true
    includeCompaction: true
    notices: true
    retryOnCodes: []
```

| Key | Default | Meaning |
| --- | --- | --- |
| `maxRetries` | `10` | Retries allowed after one failed turn. `0` disables retrying. |
| `delayMs` | `1000` | Delay before the first retry, in milliseconds. Delegated children retry immediately (see above). |
| `maxDelayMs` | `30000` | Upper bound for the exponential delay. |
| `backoff` | `2` | Delay multiplier after every failed retry (`1` = constant). |
| `retryText` | see `index.js` | Model-facing directive. `{error}` expands to the failure message. |
| `sourceKind` | `turn-retry` | Message source kind; anything but `user` stays out of the transcript. |
| `includeSubagents` | `true` | Also restart failed delegated-child turns, immediately, before the child settles. `false` skips them. |
| `includeCompaction` | `true` | Re-run a standalone compaction that closed with an error. |
| `notices` | `true` | Show a toast per retry when the host exposes `ctx.tuiToast`. |
| `retryOnCodes` | `[]` | Only restart these `LlmFailure` codes; empty means every error. |

## Test

```sh
node test.mjs
```
