package telemetry

// Cross-session roll-ups of agent activity. Everything here reads the same
// rows RecordAgentRun writes, so a subagent turn counts exactly once under its
// own conversation.

// AgentSummary is an aggregated slice of agent_runs.
type AgentSummary struct {
	Runs             int   `json:"runs"`
	Steps            int   `json:"steps"`
	ToolCalls        int   `json:"toolCalls"`
	ToolMs           int64 `json:"toolMs"`
	SkillHits        int   `json:"skillHits"`
	ThinkingMs       int64 `json:"thinkingMs"`
	DurationMs       int64 `json:"durationMs"`
	InputTokens      int64 `json:"inputTokens"`
	OutputTokens     int64 `json:"outputTokens"`
	CacheReadTokens  int64 `json:"cacheReadTokens"`
	CacheWriteTokens int64 `json:"cacheWriteTokens"`
	ReasoningTokens  int64 `json:"reasoningTokens"`
}

// PromptTokens is everything sent to the provider.
func (s AgentSummary) PromptTokens() int64 {
	return s.InputTokens + s.CacheReadTokens + s.CacheWriteTokens
}

// CacheHitRate is the prompt cache hit rate (see AgentCache.CacheHitRate).
func (s AgentSummary) CacheHitRate() float64 {
	return cacheHitRate(s.CacheReadTokens, s.PromptTokens())
}

// AgentTotals is the whole-store summary, subagents included.
type AgentTotals struct {
	AgentSummary
	Sessions         int `json:"sessions"`
	Conversations    int `json:"conversations"`
	Subagents        int `json:"subagents"`
	SubagentSessions int `json:"subagentSessions"`
}

// AgentSessionSummary is one session's totals. Labels (title, workspace) are
// the caller's to join; telemetry only knows ids.
type AgentSessionSummary struct {
	AgentSummary
	SessionID     string `json:"sessionId"`
	Conversations int    `json:"conversations"`
	Subagents     int    `json:"subagents"`
	LastRunAtMs   int64  `json:"lastRunAt"`
}

// SubagentSummary follows one subagent conversation across sessions.
type SubagentSummary struct {
	AgentSummary
	SessionID            string `json:"sessionId"`
	ConversationID       string `json:"conversationId"`
	ParentConversationID string `json:"parentConversationId"`
	Name                 string `json:"name"`
	DependsOn            string `json:"dependsOn"`
	LastRunAtMs          int64  `json:"lastRunAt"`
}

const summarySums = `COALESCE(SUM(steps), 0), COALESCE(SUM(tool_calls), 0), COALESCE(SUM(tool_ms), 0),
	COALESCE(SUM(skill_hits), 0), COALESCE(SUM(thinking_ms), 0), COALESCE(SUM(duration_ms), 0),
	COALESCE(SUM(input_tokens), 0), COALESCE(SUM(output_tokens), 0), COALESCE(SUM(cache_read_tokens), 0),
	COALESCE(SUM(cache_write_tokens), 0), COALESCE(SUM(reasoning_tokens), 0)`

// AgentTotals summarizes every stored turn.
func (s *Store) AgentTotals() (AgentTotals, error) {
	var total AgentTotals
	row := s.db.QueryRow(`SELECT COUNT(*), COUNT(DISTINCT session_id),
		COUNT(DISTINCT session_id || char(31) || conversation_id), ` + summarySums + `
		FROM agent_runs`)
	err := row.Scan(&total.Runs, &total.Sessions, &total.Conversations, &total.Steps, &total.ToolCalls,
		&total.ToolMs, &total.SkillHits, &total.ThinkingMs, &total.DurationMs, &total.InputTokens,
		&total.OutputTokens, &total.CacheReadTokens, &total.CacheWriteTokens, &total.ReasoningTokens)
	if err != nil {
		return total, err
	}
	row = s.db.QueryRow(`SELECT COUNT(*), COUNT(DISTINCT session_id) FROM agents`)
	if err := row.Scan(&total.Subagents, &total.SubagentSessions); err != nil {
		return total, err
	}
	return total, nil
}

// SessionSummaries lists the newest active sessions with their run totals and
// how many subagents each one created. A limit of 0 returns every session.
func (s *Store) SessionSummaries(limit int) ([]AgentSessionSummary, error) {
	query := `SELECT session_id, COUNT(*), COUNT(DISTINCT conversation_id), MAX(started_at), ` + summarySums + `
	 FROM agent_runs GROUP BY session_id ORDER BY MAX(id) DESC`
	args := []any{}
	if limit > 0 {
		query += ` LIMIT ?`
		args = append(args, limit)
	}
	rows, err := s.db.Query(query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []AgentSessionSummary
	for rows.Next() {
		var item AgentSessionSummary
		var summary AgentSummary
		if err := rows.Scan(&item.SessionID, &summary.Runs, &item.Conversations, &item.LastRunAtMs,
			&summary.Steps, &summary.ToolCalls, &summary.ToolMs, &summary.SkillHits, &summary.ThinkingMs,
			&summary.DurationMs, &summary.InputTokens, &summary.OutputTokens, &summary.CacheReadTokens,
			&summary.CacheWriteTokens, &summary.ReasoningTokens); err != nil {
			return nil, err
		}
		item.AgentSummary = summary
		out = append(out, item)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	counts, err := s.subagentCounts()
	if err != nil {
		return nil, err
	}
	for i := range out {
		out[i].Subagents = counts[out[i].SessionID]
	}
	return out, nil
}

// subagentCounts is the number of subagent conversations per session.
func (s *Store) subagentCounts() (map[string]int, error) {
	rows, err := s.db.Query(`SELECT session_id, COUNT(*) FROM agents GROUP BY session_id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]int{}
	for rows.Next() {
		var id string
		var count int
		if err := rows.Scan(&id, &count); err != nil {
			return nil, err
		}
		out[id] = count
	}
	return out, rows.Err()
}

// SubagentSummaries follows subagent conversations across all sessions,
// newest first, with the runs each one spent.
func (s *Store) SubagentSummaries(limit int) ([]SubagentSummary, error) {
	query := `SELECT a.session_id, a.conversation_id, a.parent_conversation_id, a.name, a.depends_on,
	   COALESCE(MAX(r.started_at), a.created_at), COUNT(r.id), ` + summarySums + `
	 FROM agents a
	 LEFT JOIN agent_runs r ON r.session_id = a.session_id AND r.conversation_id = a.conversation_id
	 GROUP BY a.session_id, a.conversation_id ORDER BY a.created_at DESC`
	args := []any{}
	if limit > 0 {
		query += ` LIMIT ?`
		args = append(args, limit)
	}
	rows, err := s.db.Query(query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []SubagentSummary
	for rows.Next() {
		var item SubagentSummary
		var summary AgentSummary
		if err := rows.Scan(&item.SessionID, &item.ConversationID, &item.ParentConversationID,
			&item.Name, &item.DependsOn, &item.LastRunAtMs, &summary.Runs, &summary.Steps, &summary.ToolCalls,
			&summary.ToolMs, &summary.SkillHits, &summary.ThinkingMs, &summary.DurationMs, &summary.InputTokens,
			&summary.OutputTokens, &summary.CacheReadTokens, &summary.CacheWriteTokens, &summary.ReasoningTokens); err != nil {
			return nil, err
		}
		item.AgentSummary = summary
		out = append(out, item)
	}
	return out, rows.Err()
}
