# dsh-plugin-daily-tokens

<sub><a href="README.md">中文</a> | English</sub>

A [DeepSeek Harness](https://github.com/deepseek-ai) (DSH) plugin that shows, beside the window traffic lights, how many tokens DSH has consumed today — digit by digit, with a rolling animation.

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![DSH](https://img.shields.io/badge/DSH-0.2.x-5b5bd6)

## Install

1. Clone or copy this repository anywhere on disk.
2. In DSH, open **Plugins → Add plugin** and pick this directory.
3. A moment later `Today 12.34M tok` appears to the right of the traffic lights.

Changing **`client.js`** only needs a page reload. Changing **`index.js`** does not hot-reload: open **Plugins**, switch this row off and back on (no app restart needed).

To install it for the whole profile, add this row to the profile's `cordis.patch.yml`:

```yaml
- insert:
    - id: daily-tokens
      name: 'dsh-plugin-daily-tokens'
      config: {}
```

The bundle ships the same content in its own `cordis.patch.yml`, so **Add plugin** already inserts it.

## Requirements

- DSH 0.2.x (uses the `shell.overlay` slot and the `session/event` feed).
- No API key: the figure comes from local session logs.

## Where the numbers come from

Vendor usage APIs (OpenCode, for one) report allowance percentages but no token counts, so this plugin counts what DSH itself recorded:

- it reads `$DSH_HOME/sessions/**/session*.jsonl(.zstd)`;
- it folds the `usage` block of every committed `assistant/message` event (`inputTokens` / `outputTokens` / `cacheReadTokens` / `cacheWriteTokens`);
- it keeps events whose time falls after local midnight, summed across every model.

## Deleting a session does not lower the figure

Because the count would otherwise depend on logs that a deleted session takes with it, the daily total is persisted separately:

- location: `$DSH_HOME/daily-tokens/<local-midnight-epoch-ms>.json` (default `~/.dsh/daily-tokens/`);
- contents: the day's counters plus a watermark of already-counted messages (`sessionId:seq`);
- writes: debounced 5 seconds after a commit, written atomically (`temp` + `rename`), force-flushed when the plugin unloads;
- read rule: **the larger of the persisted value and a fresh log recount**, so losing a log can never lower the display;
- dedupe: messages already covered by the recount are marked in the watermark, so a reload never double-counts;
- cleanup: only today's and yesterday's files are kept.

Cost: one small JSON file per day (the watermark is trimmed to the most recent 50,000 entries).

## Real-time without the cost

The Host keeps today's total in memory, fed from two places:

1. **The event feed**: a `session/event` listener folds each `assistant/message` usage block as soon as it commits — no disk access.
2. **A first baseline**: the first read scans the session logs once to cover what happened before the plugin loaded; later reads only rescan after midnight.

Events that arrive during the scan are buffered, then merged by `(sessionId, seq)` so nothing is counted twice. Measured:

| Case | Cost |
|:--|:--|
| first read (baseline scan, ~10 MB of logs) | ~300 ms |
| every later read | **0 ms** (pure memory) |
| one `assistant/message` event | an in-memory add |

Session logs are multi-frame zstd: the baseline records the byte offset of the last fully decoded frame, and a partially written tail frame simply fails to decode and is retried next time.

## Display

- Position: the window title strip, right of the traffic lights; the element is `pointer-events: none`, so it never blocks the lights or window dragging.
- Refresh: once on mount, then every second (paused while the window is hidden).
- Motion: each digit is a 0–9 column that rolls to its new value (700 ms), and the whole figure lifts and brightens for 320 ms so any change is noticeable. Both respect `prefers-reduced-motion`.
- A failed read keeps the last known figure; "unavailable" is shown only when there has never been a value.

## Limitations

- Counts only this machine's DSH session logs: usage in the OpenCode desktop app, other clients, or other machines is not included.
- Only committed assistant messages count; a stream still in flight appears after the next commit.
- Session log files larger than 256 MB are skipped.
- Crossing midnight triggers one baseline rescan (~a few hundred ms), then it is memory-only again.

## Companion plugin

For OpenCode allowance rings in the composer toolbar, see [`dsh-plugin-opencode-quota`](https://github.com/mi2466172099/dsh-plugin-opencode-quota).

## License

MIT — see [LICENSE](LICENSE).
