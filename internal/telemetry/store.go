// Package telemetry stores numeric agent activity: one row per finished turn,
// plus the agent graph. It knows nothing about chat sessions, titles or the
// harness: callers report facts with opaque ids, and read aggregates back.
//
// It has its own SQLite file so that analysis data survives independently of
// the team state and the durable transcripts.
package telemetry

import (
	"database/sql"
	"encoding/json"
	"path/filepath"
	"strings"
	"time"

	_ "modernc.org/sqlite"
)

// Agent is one agent node: the root conversation or a subagent.
// DependsOn is the comma-separated agent names it waited for.
type Agent struct {
	SessionID            string    `json:"sessionId"`
	ConversationID       string    `json:"conversationId"`
	ParentConversationID string    `json:"parentConversationId"`
	Name                 string    `json:"name"`
	DependsOn            string    `json:"dependsOn"`
	CreatedAt            time.Time `json:"-"`
}

// AgentRun is one finished turn of one agent.
type AgentRun struct {
	ID                   int64    `json:"-"`
	SessionID            string   `json:"sessionId"`
	ConversationID       string   `json:"conversationId"`
	Agent                string   `json:"agent"`
	ParentConversationID string   `json:"parentConversationId"`
	Turn                 int      `json:"turn"`
	StartedAtMs          int64    `json:"startedAt"`
	DurationMs           int64    `json:"durationMs"`
	Steps                int      `json:"steps"`
	ToolCalls            int      `json:"toolCalls"`
	ToolMs               int64    `json:"toolMs"`
	SkillHits            int      `json:"skillHits"`
	Skills               []string `json:"skills"`
	ThinkingMs           int64    `json:"thinkingMs"`
	InputTokens          int64    `json:"inputTokens"`
	OutputTokens         int64    `json:"outputTokens"`
	CacheReadTokens      int64    `json:"cacheReadTokens"`
	CacheWriteTokens     int64    `json:"cacheWriteTokens"`
	ReasoningTokens      int64    `json:"reasoningTokens"`
	Failure              string   `json:"failure"`
}

// SkillNames lists the skills the turn used.
func (r AgentRun) SkillNames() []string { return r.Skills }

// StartedAt is the wall clock of the turn's first request.
func (r AgentRun) StartedAt() time.Time { return time.UnixMilli(r.StartedAtMs) }

// AgentCache is the token and cache total of one agent.
type AgentCache struct {
	SessionID        string `json:"sessionId"`
	ConversationID   string `json:"conversationId"`
	Agent            string `json:"agent"`
	Runs             int    `json:"runs"`
	InputTokens      int64  `json:"inputTokens"`
	OutputTokens     int64  `json:"outputTokens"`
	CacheReadTokens  int64  `json:"cacheReadTokens"`
	CacheWriteTokens int64  `json:"cacheWriteTokens"`
}

// PromptTokens is everything sent to the provider: uncached input, cache
// reads and cache writes.
func (c AgentCache) PromptTokens() int64 {
	return c.InputTokens + c.CacheReadTokens + c.CacheWriteTokens
}

// CacheHitRate is the share of the prompt served from the provider's cache,
// which is what "cache hit rate" means for DeepSeek and OpenAI-compatible
// endpoints. Zero when the provider reported no prompt tokens.
func (c AgentCache) CacheHitRate() float64 { return cacheHitRate(c.CacheReadTokens, c.PromptTokens()) }

func cacheHitRate(read, prompt int64) float64 {
	if prompt <= 0 {
		return 0
	}
	return float64(read) / float64(prompt)
}

// Store is the telemetry database.
type Store struct {
	db *sql.DB
}

// Open creates or opens telemetry.db in dir.
func Open(dir string) (*Store, error) {
	db, err := sql.Open("sqlite", filepath.Join(dir, "telemetry.db"))
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)
	s := &Store{db: db}
	if err := s.migrate(); err != nil {
		db.Close()
		return nil, err
	}
	return s, nil
}

func (s *Store) migrate() error {
	_, err := s.db.Exec(`
PRAGMA journal_mode=WAL;
CREATE TABLE IF NOT EXISTS agents (
	session_id TEXT NOT NULL,
	conversation_id TEXT NOT NULL,
	parent_conversation_id TEXT NOT NULL DEFAULT '',
	name TEXT NOT NULL,
	depends_on TEXT NOT NULL DEFAULT '',
	created_at INTEGER NOT NULL,
	PRIMARY KEY(session_id, conversation_id)
);
CREATE TABLE IF NOT EXISTS agent_runs (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	session_id TEXT NOT NULL,
	conversation_id TEXT NOT NULL,
	agent TEXT NOT NULL,
	parent_conversation_id TEXT NOT NULL DEFAULT '',
	turn INTEGER NOT NULL,
	started_at INTEGER NOT NULL,
	duration_ms INTEGER NOT NULL,
	steps INTEGER NOT NULL,
	tool_calls INTEGER NOT NULL,
	tool_ms INTEGER NOT NULL,
	skill_hits INTEGER NOT NULL,
	skills TEXT NOT NULL DEFAULT '',
	thinking_ms INTEGER NOT NULL,
	input_tokens INTEGER NOT NULL,
	output_tokens INTEGER NOT NULL,
	cache_read_tokens INTEGER NOT NULL,
	cache_write_tokens INTEGER NOT NULL,
	reasoning_tokens INTEGER NOT NULL,
	failure TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS agent_runs_session ON agent_runs(session_id, id);
`)
	return err
}

// Close closes the database.
func (s *Store) Close() error { return s.db.Close() }

func splitList(value string) []string {
	if strings.TrimSpace(value) == "" {
		return nil
	}
	parts := strings.Split(value, ",")
	out := make([]string, 0, len(parts))
	for _, part := range parts {
		if item := strings.TrimSpace(part); item != "" {
			out = append(out, item)
		}
	}
	return out
}

// RecordAgent stores an agent node, refreshing a node reported twice by a
// replay.
func (s *Store) RecordAgent(agent Agent) error {
	_, err := s.db.Exec(
		`INSERT INTO agents(session_id, conversation_id, parent_conversation_id, name, depends_on, created_at)
		 VALUES(?, ?, ?, ?, ?, ?)
		 ON CONFLICT(session_id, conversation_id) DO UPDATE SET
		   parent_conversation_id = excluded.parent_conversation_id,
		   name = excluded.name,
		   depends_on = excluded.depends_on`,
		agent.SessionID, agent.ConversationID, agent.ParentConversationID, agent.Name, agent.DependsOn, time.Now().UnixMilli(),
	)
	return err
}

// Agents lists the agents of a session in creation order.
func (s *Store) Agents(sessionID string) ([]Agent, error) {
	rows, err := s.db.Query(
		`SELECT session_id, conversation_id, parent_conversation_id, name, depends_on, created_at
		 FROM agents WHERE session_id = ? ORDER BY created_at, conversation_id`, sessionID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Agent
	for rows.Next() {
		var item Agent
		var created int64
		if err := rows.Scan(&item.SessionID, &item.ConversationID, &item.ParentConversationID, &item.Name, &item.DependsOn, &created); err != nil {
			return nil, err
		}
		item.CreatedAt = time.UnixMilli(created)
		out = append(out, item)
	}
	return out, rows.Err()
}

// RecordAgentRun stores one finished turn.
func (s *Store) RecordAgentRun(run AgentRun) error {
	_, err := s.db.Exec(
		`INSERT INTO agent_runs(session_id, conversation_id, agent, parent_conversation_id, turn, started_at,
		   duration_ms, steps, tool_calls, tool_ms, skill_hits, skills, thinking_ms, input_tokens, output_tokens,
		   cache_read_tokens, cache_write_tokens, reasoning_tokens, failure)
		 VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		run.SessionID, run.ConversationID, run.Agent, run.ParentConversationID, run.Turn, run.StartedAtMs,
		run.DurationMs, run.Steps, run.ToolCalls, run.ToolMs, run.SkillHits, strings.Join(run.Skills, ","), run.ThinkingMs,
		run.InputTokens, run.OutputTokens, run.CacheReadTokens, run.CacheWriteTokens, run.ReasoningTokens, run.Failure,
	)
	return err
}

// AgentRuns lists the newest turns of a session, oldest first. A limit of 0
// returns every turn.
func (s *Store) AgentRuns(sessionID string, limit int) ([]AgentRun, error) {
	query := `SELECT id, session_id, conversation_id, agent, parent_conversation_id, turn, started_at,
	   duration_ms, steps, tool_calls, tool_ms, skill_hits, skills, thinking_ms, input_tokens, output_tokens,
	   cache_read_tokens, cache_write_tokens, reasoning_tokens, failure
	 FROM agent_runs WHERE session_id = ? ORDER BY id DESC`
	args := []any{sessionID}
	if limit > 0 {
		query += ` LIMIT ?`
		args = append(args, limit)
	}
	rows, err := s.db.Query(query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out, err := scanRuns(rows)
	if err != nil {
		return nil, err
	}
	for i, j := 0, len(out)-1; i < j; i, j = i+1, j-1 {
		out[i], out[j] = out[j], out[i]
	}
	return out, nil
}

func scanRuns(rows *sql.Rows) ([]AgentRun, error) {
	var out []AgentRun
	for rows.Next() {
		var item AgentRun
		var skills string
		if err := rows.Scan(&item.ID, &item.SessionID, &item.ConversationID, &item.Agent, &item.ParentConversationID,
			&item.Turn, &item.StartedAtMs, &item.DurationMs, &item.Steps, &item.ToolCalls, &item.ToolMs,
			&item.SkillHits, &skills, &item.ThinkingMs, &item.InputTokens, &item.OutputTokens,
			&item.CacheReadTokens, &item.CacheWriteTokens, &item.ReasoningTokens, &item.Failure); err != nil {
			return nil, err
		}
		item.Skills = splitList(skills)
		out = append(out, item)
	}
	return out, rows.Err()
}

// AgentCacheStats aggregates each agent's turns into its token and cache
// totals.
func (s *Store) AgentCacheStats(sessionID string) ([]AgentCache, error) {
	rows, err := s.db.Query(
		`SELECT session_id, conversation_id, agent, COUNT(*),
		   SUM(input_tokens), SUM(output_tokens), SUM(cache_read_tokens), SUM(cache_write_tokens)
		 FROM agent_runs WHERE session_id = ?
		 GROUP BY conversation_id, agent ORDER BY MIN(id)`, sessionID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []AgentCache
	for rows.Next() {
		var item AgentCache
		if err := rows.Scan(&item.SessionID, &item.ConversationID, &item.Agent, &item.Runs,
			&item.InputTokens, &item.OutputTokens, &item.CacheReadTokens, &item.CacheWriteTokens); err != nil {
			return nil, err
		}
		out = append(out, item)
	}
	return out, rows.Err()
}

// DecodeAgentRun decodes one runtime metric report.
func DecodeAgentRun(data string) (AgentRun, error) {
	var run AgentRun
	err := json.Unmarshal([]byte(data), &run)
	return run, err
}

// DecodeAgent decodes one runtime agent report.
func DecodeAgent(data string) (Agent, error) {
	var agent Agent
	err := json.Unmarshal([]byte(data), &agent)
	return agent, err
}
