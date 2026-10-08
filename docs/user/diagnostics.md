# Diagnose desktop performance

Open **Settings > Diagnostics** in the desktop app to inspect live processes and resource history.

If the interface feels consistently slow without freezing, select **Capture renderer CPU profile**.
T3 Code records five seconds of renderer activity and saves the profile in its diagnostics folder.
Profile capture is rate-limited and stops automatically. Use **Open logs folder** on the same page to
locate the diagnostics data when reporting a performance problem.

## Tune server responsiveness

Performance timing applies to every client connected to an environment. The defaults balance
streaming responsiveness with database and sidebar work. To tune an environment, add a
`performance` object to `<T3 home>/userdata/settings.json`:

```json
{
  "performance": {
    "shellStateBatchMs": 50,
    "shellTextBatchMs": 250,
    "codexTextFlushMs": 100,
    "gitBranchChangesCacheMs": 10000,
    "eventLoopReportIntervalMs": 30000
  }
}
```

Keep the rest of your settings when editing the file. You can also apply this object with
`t3 settings patch --file <json-file> --base-dir <T3 home>`. Omitted fields keep their current values
in a patch and use defaults in the settings file.

| Setting                     | What it controls                                      | Allowed range  |
| --------------------------- | ----------------------------------------------------- | -------------- |
| `shellStateBatchMs`         | Sidebar state updates                                 | 5–100 ms       |
| `shellTextBatchMs`          | Sidebar refreshes during assistant text and reasoning | 5–1000 ms      |
| `gitBranchChangesCacheMs`   | Reuse of branch diff totals between status refreshes  | 0–60000 ms     |
| `codexTextFlushMs`          | Codex text and reasoning streaming                    | 20–500 ms      |
| `eventLoopReportIntervalMs` | Event-loop delay reports in server traces             | 5000–300000 ms |

The text batching interval must be at least the state batching interval. Larger batching intervals
reduce repeated work but make streaming updates less frequent. A timer already in progress keeps
its deadline; new windows use the updated settings. Turn completion and interruption flush
buffered Codex text immediately. No restart is required.

Branch diff totals may lag file edits by up to `gitBranchChangesCacheMs`. Basic Git status stays
fresh. Explicit refreshes and Git actions bypass this cache; set the interval to `0` to disable it.
