package app

import (
	"github.com/QinYangWang/omo/internal/telemetry"
)

// currentSessionID is the team identity the runtime reports metrics under.
func (a *App) currentSessionID() string {
	return a.TeamID()
}

// applyAgentRun stores one finished turn reported by the runtime and refreshes
// the cached per-agent view.
func (a *App) applyAgentRun(data string) {
	run, err := telemetry.DecodeAgentRun(data)
	if err != nil {
		a.Logf("bad agent metric: %v", err)
		return
	}
	if run.SessionID == "" {
		run.SessionID = a.currentSessionID()
	}
	if run.SessionID == "" {
		return
	}
	if err := a.Telemetry.RecordAgentRun(run); err != nil {
		a.Logf("store agent metric: %v", err)
		return
	}
	a.refreshAgentActivity(run.SessionID)
}

// applyAgent stores one agent node of the dependency graph.
func (a *App) applyAgent(data string) {
	agent, err := telemetry.DecodeAgent(data)
	if err != nil {
		a.Logf("bad agent record: %v", err)
		return
	}
	if agent.SessionID == "" {
		agent.SessionID = a.currentSessionID()
	}
	if agent.SessionID == "" || agent.ConversationID == "" {
		return
	}
	if err := a.Telemetry.RecordAgent(agent); err != nil {
		a.Logf("store agent record: %v", err)
		return
	}
	a.refreshAgentActivity(agent.SessionID)
}

// refreshAgentActivity reloads the cached per-turn, per-agent and agent-graph
// data for sessionID and publishes it to the window.
func (a *App) refreshAgentActivity(sessionID string) {
	runs, cache, agents := a.loadAgentActivity(sessionID)
	a.update(func() {
		if a.currentSessionID() != sessionID {
			return
		}
		a.AgentRuns = runs
		a.AgentCache = cache
		a.Agents = agents
	})
}

// loadAgentActivity reads the stored activity of a session.
func (a *App) loadAgentActivity(sessionID string) (runs []telemetry.AgentRun, cache []telemetry.AgentCache, agents []telemetry.Agent) {
	var err error
	if runs, err = a.Telemetry.AgentRuns(sessionID, 200); err != nil {
		a.Logf("list agent runs: %v", err)
	}
	if cache, err = a.Telemetry.AgentCacheStats(sessionID); err != nil {
		a.Logf("list agent cache: %v", err)
	}
	if agents, err = a.Telemetry.Agents(sessionID); err != nil {
		a.Logf("list agents: %v", err)
	}
	return runs, cache, agents
}

// AgentRunsFor returns the stored turns of a session, oldest first.
func (a *App) AgentRunsFor(sessionID string) []telemetry.AgentRun {
	runs, err := a.Telemetry.AgentRuns(sessionID, 0)
	if err != nil {
		a.Logf("list agent runs: %v", err)
		return nil
	}
	return runs
}

// AgentCacheFor returns the per-agent cache totals of a session.
func (a *App) AgentCacheFor(sessionID string) []telemetry.AgentCache {
	cache, err := a.Telemetry.AgentCacheStats(sessionID)
	if err != nil {
		a.Logf("list agent cache: %v", err)
		return nil
	}
	return cache
}

// AgentOverview is the cross-session roll-up: totals, per-session summaries,
// and every subagent conversation, newest first.
type AgentOverview struct {
	Totals    telemetry.AgentTotals           `json:"totals"`
	Sessions  []telemetry.AgentSessionSummary `json:"sessions"`
	Subagents []telemetry.SubagentSummary     `json:"subagents"`
}

// AgentOverview reads the cross-session agent summaries. It is meant for the
// UI and plugins; the built-in UI does not show it yet.
func (a *App) AgentOverview() AgentOverview {
	var overview AgentOverview
	totals, err := a.Telemetry.AgentTotals()
	if err != nil {
		a.Logf("agent totals: %v", err)
	}
	sessions, err := a.Telemetry.SessionSummaries(50)
	if err != nil {
		a.Logf("agent session summaries: %v", err)
	}
	subagents, err := a.Telemetry.SubagentSummaries(200)
	if err != nil {
		a.Logf("subagent summaries: %v", err)
	}
	overview.Totals = totals
	overview.Sessions = sessions
	overview.Subagents = subagents
	return overview
}
