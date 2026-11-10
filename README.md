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
   fresh prompt. Subagent sessions are skipped by default: their parent already
   received the failure, so restarting them in the background would be orphan
   work. Set `includeSubagents: true` to restart them anyway — a failed
   subagent returns no result and the parent has no handle to resume it, so the
   observable outcome of skipping is a lost delegation.

## Compactions

A compaction is **not** a turn, so the `turn/end` watcher never fires for it.
The host brackets every compaction with `compaction/start` and `compaction/end`,
and that bracket carries no outcome — the translator even hardcodes `ok: true`.
What distinguishes success is the checkpoint message: a successful compaction
appends a `user/message` whose source kind is `compact-checkpoint`, and a failed
one appends nothing. So the test is *did a checkpoint land inside the bracket*.

On failure the plugin injects the same hidden followup the turn path uses, and
it works for the same reason: the context is still over its threshold, so the
next turn triggers auto-compaction again. It carries its **own** budget, because
a followup that completes a turn would otherwise reset the turn budget and let a
permanently-failing summarizer loop forever. Only a fresh human prompt resets
it. `includeCompaction: false` turns the whole path off.

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
    includeSubagents: false
    includeCompaction: true
    notices: true
    retryOnCodes: []
```

| Key | Default | Meaning |
| --- | --- | --- |
| `maxRetries` | `10` | Retries allowed after one failed turn. `0` disables retrying. |
| `delayMs` | `1000` | Delay before the first retry, in milliseconds. |
| `maxDelayMs` | `30000` | Upper bound for the exponential delay. |
| `backoff` | `2` | Delay multiplier after every failed retry (`1` = constant). |
| `retryText` | see `index.js` | Model-facing directive. `{error}` expands to the failure message. |
| `sourceKind` | `turn-retry` | Message source kind; anything but `user` stays out of the transcript. |
| `includeSubagents` | `false` | Also restart failed subagent turns. |
| `includeCompaction` | `true` | Also restart a compaction that closed without committing a checkpoint. |
| `notices` | `true` | Show a toast per retry when the host exposes `ctx.tuiToast`. |
| `retryOnCodes` | `[]` | Only restart these `LlmFailure` codes; empty means every error. |

## Test

```sh
node test.mjs
```
