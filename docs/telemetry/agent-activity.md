# telemetry agent activity

Owner: `telemetry` (`internal/telemetry`, `docs/telemetry/`).

Numeric facts about agent work: one row per finished turn, plus the agent
graph. It stores no messages and no labels — those live in the team ledger and
the roster. The producing side is `docs/runtime/agent-contract.md`.

## Storage

`<data dir>/telemetry.db` (SQLite, WAL), separate from the team's `bots/` state
and the durable transcript.

```sql
CREATE TABLE agents (
    session_id             TEXT NOT NULL,      -- team id
    conversation_id        TEXT NOT NULL,
    parent_conversation_id TEXT NOT NULL DEFAULT '',
    name                   TEXT NOT NULL,      -- subagent name
    depends_on             TEXT NOT NULL DEFAULT '',
    created_at             INTEGER NOT NULL,   -- epoch ms
    PRIMARY KEY (session_id, conversation_id)
);

CREATE TABLE agent_runs (
    id                     INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id             TEXT NOT NULL,
    conversation_id        TEXT NOT NULL,
    agent                  TEXT NOT NULL,      -- Bot name | subagent:<name>
    parent_conversation_id TEXT NOT NULL DEFAULT '',
    turn                   INTEGER NOT NULL,   -- 1-based per conversation
    started_at             INTEGER NOT NULL,   -- epoch ms
    duration_ms            INTEGER NOT NULL,
    steps                  INTEGER NOT NULL,   -- model rounds
    tool_calls             INTEGER NOT NULL,
    tool_ms                INTEGER NOT NULL,
    skill_hits             INTEGER NOT NULL,
    skills                 TEXT NOT NULL DEFAULT '',  -- comma-separated
    thinking_ms            INTEGER NOT NULL,
    input_tokens           INTEGER NOT NULL,   -- uncached prompt
    output_tokens          INTEGER NOT NULL,
    cache_read_tokens      INTEGER NOT NULL,
    cache_write_tokens     INTEGER NOT NULL,
    reasoning_tokens       INTEGER NOT NULL,
    failure                TEXT NOT NULL DEFAULT ''
);
```

`agent_runs` is append-only; `agents` is upserted by primary key so a replay
does not duplicate a node. `CREATE TABLE IF NOT EXISTS` upgrades an existing
file in place.

## Go types (`internal/telemetry`)

| Type / method | Contract |
| --- | --- |
| `Agent` | one agent node; `CreatedAt` is not part of the report |
| `AgentRun` | one turn; JSON tags match `RunMetric` exactly |
| `AgentCache` | per-conversation totals with `PromptTokens()` / `CacheHitRate()` |
| `(Store) RecordAgent`, `Agents(sessionID)` | agent graph |
| `(Store) RecordAgentRun`, `AgentRuns(sessionID, limit)` | turns, oldest first; 0 = all |
| `(Store) AgentCacheStats(sessionID)` | per-conversation totals |
| `AgentTotals()`, `SessionSummaries(limit)`, `SubagentSummaries(limit)` | cross-session roll-ups |
| `DecodeAgentRun`, `DecodeAgent` | decode one host report |

Cache accounting, everywhere the same:

```text
promptTokens = inputTokens + cacheReadTokens + cacheWriteTokens
cacheHitRate = cacheReadTokens / promptTokens        (0 when promptTokens = 0)
```

## Cross-session roll-ups

- `AgentTotals`: whole store. `Sessions`, `Conversations` (distinct
  session+conversation pairs), `Subagents` (rows in `agents`), plus sums.
- `SessionSummaries`: per session, newest active first; `limit` 0 = all. Labels
  (title, workspace) are **not** stored here; the caller joins them from the
  roster.
- `SubagentSummaries`: every subagent conversation with its session,
  conversation, parent, name, depends_on, last run and own totals.

A subagent turn is counted once, under its own conversation; it is never folded
into its parent's row.

## App wiring (`internal/app/agents.go`)

`App.Start()` consumes engine events `metric` and `agent`, decodes them, fills a
missing `sessionId` from `App.TeamID()`, writes them and refreshes
`App.AgentRuns` (newest 200), `App.AgentCache`, `App.Agents`. `App.LastRun` is
the `metrics` object of the newest snapshot. `App.AgentOverview()` bundles
totals, the newest 50 sessions and the newest 200 subagents for a UI or plugin.

Sessions are gone: telemetry never reads the old chat database, and
`session_id` is the stable team id (`t<sha256(workspace)[:6]>`).
