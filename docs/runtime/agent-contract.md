# runtime agent contract

Owner: `runtime` (`pi-runtime/`, `internal/runtime/moejs`).

Data contract between the Go host and the bundled pi-durable runtime. `core`
consumes it; change it together with `docs/telemetry/agent-activity.md` and
`docs/bots/design.md`.

## JS API (`pi-runtime/src/main.ts`)

`__pi_register` installs exactly these exports; the engine refuses to load a
bundle missing one:

| Export | Signature |
| --- | --- |
| `openTeam` | `(TeamConfig, onEvent(kind, json)) => Promise<void>` |
| `sendToBot` | `(botId, text, onDone(json)) => Promise<void>` |
| `abortBot` | `(botId, onDone(json)) => Promise<void>` |
| `closeTeam` | `() => Promise<void>` |
| `listCatalog` | `(baseUrl, model, customModelsJson) => string` |

## `TeamConfig` (Go `moejsruntime.TeamConfig`)

One durable database per team (one workspace = one team), one conversation per
Bot.

| Field | JSON | Type | Meaning |
| --- | --- | --- | --- |
| `DBPath` | `dbPath` | string | the team's durable SQLite file |
| `TeamID` | `teamId` | string | stable team id; echoed as `sessionId` in metrics |
| `BaseURL` | `baseUrl` | string | OpenAI-compatible endpoint |
| `Provider` | `provider` | string | default pi-ai provider |
| `Model` | `model` | string | default pi-ai model |
| `CustomModels` | `customModels` | string[] | extra ids for the custom provider |
| `Workspace` | `workspace` | string | workspace root, also the agent `cwd` |
| `Credentials` | `credentials` | map<string,string> | provider id → key, in memory only |
| `MaxTokens` | `maxTokens` | number | answer budget |
| `Temperature` | `temperature` | number | sampling temperature |
| `MaxTurns` | `maxTurns` | number | tool rounds per run, default 40 |
| `Skills` | `skills` | `Skill[]` | discovered skills (name, description, path, content) |
| `Bots` | `bots` | `TeamBot[]` | the roster, in display order |

`TeamBot`: `{ id, name, instructions?, provider?, model?, conversationId? }`.
An empty `conversationId` means "create one"; the runtime reports the new id
with a `bot_session` event and the host persists it, so a reopen reuses the
same conversation.

Each Bot runs with its own model when set, else the team default, and with
`TEAM_INSTRUCTIONS` + its own `instructions` + `SYSTEM_INSTRUCTIONS`. Skills are
listed in the system prompt sorted by name (stable prefix for prompt caching);
the runtime must not read skill files.

For the synthetic `openai-compatible` provider: ids containing `deepseek` get
`contextWindow: 65536`, `maxTokens` 8192 unless the host sends one, and
`reasoning: true` for `reasoner`/`think`/`r1`; other ids get 128000.

## Engine events

| Kind | Payload |
| --- | --- |
| `team` | `{ ready, failure? }` |
| `bot_session` | `{ botId, conversationId }` |
| `bot` | Bot snapshot (below) — on every commit, and as the `sendToBot` result |
| `sent` / `aborted` | Bot snapshot of the finished/failed turn |
| `metric` | `RunMetric` for one finished turn |
| `agent` | one agent node of the subagent graph |
| `error` | fatal runtime error text |

Bot snapshot:

```json
{
  "botId": "b…",
  "status": "idle|running|tool|error",
  "messages": [{ "id": 8, "role": "user|assistant", "text": "…" }],
  "partial": "streaming text",
  "tool": { "name": "read_file", "status": "running" },
  "failure": "",
  "metrics": { "…RunMetric": "…" }
}
```

## Host reports

Fire-and-forget; a rejected report must never fail a run.

- `__host_metric` — one finished turn: `sessionId`, `conversationId`, `agent`
  (Bot name), `parentConversationId?`, `turn`, `startedAt`, `durationMs`,
  `steps`, `toolCalls`, `toolMs`, `skillHits`, `skills`, `thinkingMs`,
  `inputTokens`, `outputTokens`, `cacheReadTokens`, `cacheWriteTokens`,
  `reasoningTokens`, `failure?`. All ids are strings; times are milliseconds.
- `__host_agent` — `{ sessionId, conversationId, parentConversationId, name,
  dependsOn }` for a subagent node.

Measurement rules: the runtime observes each conversation's committed entries
and attributes the time between arrivals to the following entry (assistant →
`thinkingMs`, tool result → `toolMs`). Tokens come from each assistant entry's
pi-ai `Usage`; a compaction summary has no entry and is not part of a turn.
Parallel tool results committed together report 0 ms for all but the first.
