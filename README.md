# Devin Local - background subagent cancellation / stuck-turn evidence bundle

Evidence for three related failures in Devin CLI / Devin Desktop (local sessions,
`devin.exe` v3000.11.3, commit `9c803229faa4`, Windows), captured on the affected
machine.

Both front-ends are ACP clients of the same `devin.exe acp` agent process:

- **Devin CLI** = `chisel::repl` TUI (ACP client) + `devin.exe acp` child
- **Devin Desktop** = Electron (VS Code fork) -> `@exa/windsurf-acp` +
  `@exa/chat-client`, talking to `devin.exe acp`

## The three failures

1. **Desktop: sending a queued message kills background subagents.**
   The queued-message force-send path (`interruptWithQueuedMessage`, via helper
   `tgp` in `chat-client`) issues `session/cancel` and then re-sends the message
   as `session/prompt`. `session/cancel` tears down the still-open turn and its
   running background subagents, so they report `Canceled by user`.
   This contradicts `subagents.mdx` ("Running subagents park with their state
   intact and resume on your next message").

   Evidence: `logs/desktop-queued-send-kills-subagents.excerpt.log`
   - `run_subagent` x3 at `21:45:48`
   - final agent output saved `21:45:52`, but `await_turn_completion` stays
     open (idle=47.7s) because the turn is held open by the running children
   - `session/cancel` at `21:46:20.720` -- the queued "Hi there" being sent
   - `WARN ACP: subagent event for unknown child 9baa1048` at `21:46:20.824`,
     child events arriving after the cancel tore down the subagent registry
   - contrast: a `/bug` submitted at `21:46:22` completed normally at
     `21:46:50` (`Bug report submitted: https://slack.com/...`) because that
     turn's teardown had already finished, i.e. the slash-command path itself
     works when the chain is free.

2. **Turn held open while background subagents run: "[Typing]" + queued input.**
   `session/prompt` -> `prompt:await_turn_completion` does not return when the
   agent yields; it waits until background subagents drain, so every client
   shows the turn as active and queues input.

   Evidence: `logs/cli-turn-held-open-slash-command-wedged.excerpt.log`
   - last agent output saved `21:59:55`
   - `await_turn_completion` only unwinds at `22:00:39` (idle=61.9s), and only
     because a `session/cancel` landed
   - subagent exec calls (`sleep 60/90/120`, `agent-C-report.txt` write) were
     still mid-flight when the cancel hit

3. **CLI: `/bug` queues behind the wedged turn, then the session is stuck.**
   `/bug` is delivered as `session/prompt` -> `handle_slash_command_on_chain`
   (`chisel_agent::acp_server::slash_commands`), which waits for the main chain
   (cf. the binary's own "Another turn is already running on the main chain").
   After a turn is cancelled while it has running background subagents, the
   chain never frees: the wait has no timeout, and subsequent prompts hang too.

   Evidence:
   - `logs/cli-turn-held-open-slash-command-wedged.excerpt.log`:
     `/bug` entered `handle_slash_command_on_chain`, sat **idle=456s**, released
     only by `session/end` (process teardown) at `22:08:15`. Three
     `session/cancel` dispatches (Esc presses) no-op'd.
   - `logs/cli-resumed-slash-command-wedged-6h.excerpt.log`:
     the next CLI process re-loaded `meowing-drum` at `22:08:19`, re-sent the
     queued `/bug` at `22:08:26`, and it sat in `handle_slash_command_on_chain`
     for **idle=23488s (~6.5 hours)** until the app was closed. The only log
     activity during the entire window was the 15s-periodic skills poll.

## The local fix (Devin Desktop only)

`patches/` contains the change applied on this machine to the two JS bundles:

- `resources/app/out/vs/workbench/windsurf-chat-client/index.js`
- `resources/app/node_modules/@exa/chat-client/index.js`

Two spots were patched:

1. `tgp` (queued-message force-send) previously did `session/cancel` + wait +
   `session/prompt` whenever the session status was "working". The patched
   version sends `session/prompt` directly: the server steers the message into
   the open turn. It also caps the UI-side wait at 5s, since the prompt RPC
   only resolves when the held-open turn drains.
   Files: `tgp.before.js`, `tgp.after.js`, `tgp.patch`.

2. The composer submit branch enqueued the typed message while the session was
   working and only auto-sent it for an explicit send-now flag or a pending
   permission question; otherwise the message sat in the queue and needed a
   second Enter (the "double-enter" problem). The patched version always calls
   `x(t.id)` (interruptWithQueuedMessage -> the patched `tgp` -> steered
   `session/prompt`), so a single Enter sends the message into the running
   turn. If the send fails, `eGQ` re-queues it automatically.
   Files: `queued-send-submit.before.js`, `queued-send-submit.after.js`,
   `queued-send-submit.patch`.

## The repro

`repro/acp-probe.js` is a standalone Node script that speaks ACP over stdio to
`devin.exe acp`, the exact protocol the CLI/Desktop use, with no UI involved.
It launches a real background subagent, then sends a second `session/prompt`
mid-turn without `session/cancel`.

`repro/acp-probe-prompt.log` shows the result: the parent answered `pong` ~4s
after the second prompt while subagent `64b845fd` kept running (its exec calls
visible for 80+ seconds afterward). Proof that a mid-turn `session/prompt`
steers correctly and preserves background subagents; no cancel needed.

Notably, neither `session/prompt` returned a JSON-RPC response while the
subagent was alive, consistent with `await_turn_completion` only resolving
when children drain.

## Known unfixed

- The CLI's wedge/`/bug`/interrupt semantics live inside the `devin.exe` Rust
  binary (`affogato`/`chisel` crates); not client-patchable.
- Desktop's explicit Stop button (`cancelInvocation` -> `session/cancel`) still
  hard-cancels subagents; park-on-interrupt has to be fixed server-side.
