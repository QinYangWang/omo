package telemetry

import (
	"testing"
)

func TestAgentRunAndCacheStats(t *testing.T) {
	store, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()

	runs := []AgentRun{
		{SessionID: "s1", ConversationID: "root", Agent: "root", Turn: 1, Steps: 2, ToolCalls: 3, ToolMs: 120,
			SkillHits: 1, Skills: []string{"pdf"}, ThinkingMs: 900, InputTokens: 100, OutputTokens: 40,
			CacheReadTokens: 300, CacheWriteTokens: 0, ReasoningTokens: 10},
		{SessionID: "s1", ConversationID: "root", Agent: "root", Turn: 2, Steps: 1, InputTokens: 50,
			OutputTokens: 20, CacheReadTokens: 450},
		{SessionID: "s1", ConversationID: "child", Agent: "subagent:review", Turn: 1, InputTokens: 10,
			OutputTokens: 5, CacheReadTokens: 90, CacheWriteTokens: 10},
	}
	for i, run := range runs {
		run.StartedAtMs = int64(1000 + i)
		if err := store.RecordAgentRun(run); err != nil {
			t.Fatal(err)
		}
	}

	got, err := store.AgentRuns("s1", 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 3 || got[0].Turn != 1 || got[2].Agent != "subagent:review" {
		t.Fatalf("runs not returned oldest first: %+v", got)
	}
	if len(got[0].Skills) != 1 || got[0].Skills[0] != "pdf" {
		t.Fatalf("skill names did not round-trip: %+v", got[0].Skills)
	}
	if got[0].StartedAt().UnixMilli() != 1000 {
		t.Fatalf("startedAt did not round-trip: %d", got[0].StartedAt().UnixMilli())
	}
	if limited, err := store.AgentRuns("s1", 2); err != nil || len(limited) != 2 || limited[0].Turn != 2 || limited[1].Agent != "subagent:review" {
		t.Fatalf("limit should keep the newest runs, oldest first: %+v %v", limited, err)
	}

	stats, err := store.AgentCacheStats("s1")
	if err != nil {
		t.Fatal(err)
	}
	if len(stats) != 2 || stats[0].Runs != 2 || stats[1].Runs != 1 {
		t.Fatalf("unexpected per-agent grouping: %+v", stats)
	}
	root := stats[0]
	if root.PromptTokens() != 900 || root.CacheReadTokens != 750 {
		t.Fatalf("unexpected cache totals: %+v", root)
	}
	if rate := root.CacheHitRate(); rate < 0.83 || rate > 0.84 {
		t.Fatalf("cache hit rate = %v, want about 0.833", rate)
	}
}

func TestAgentsGraph(t *testing.T) {
	store, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()

	if err := store.RecordAgent(Agent{SessionID: "s1", ConversationID: "child", ParentConversationID: "root",
		Name: "review", DependsOn: "build"}); err != nil {
		t.Fatal(err)
	}
	// A replay reports the same node again.
	if err := store.RecordAgent(Agent{SessionID: "s1", ConversationID: "child", ParentConversationID: "root",
		Name: "review", DependsOn: "build"}); err != nil {
		t.Fatal(err)
	}
	agents, err := store.Agents("s1")
	if err != nil {
		t.Fatal(err)
	}
	if len(agents) != 1 {
		t.Fatalf("replayed agent should not duplicate: %+v", agents)
	}
	if agents[0].Name != "review" || agents[0].ParentConversationID != "root" || agents[0].DependsOn != "build" {
		t.Fatalf("unexpected agent record: %+v", agents[0])
	}
}

func TestCrossSessionSummaries(t *testing.T) {
	store, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()

	first := struct{ ID string }{ID: "s1"}
	second := struct{ ID string }{ID: "s2"}

	runs := []AgentRun{
		{SessionID: first.ID, ConversationID: "1", Agent: "root", Turn: 1, Steps: 2, ToolCalls: 1, ToolMs: 30,
			ThinkingMs: 700, DurationMs: 800, SkillHits: 1, Skills: []string{"pdf"},
			InputTokens: 100, OutputTokens: 50, CacheReadTokens: 300, CacheWriteTokens: 20, ReasoningTokens: 5},
		{SessionID: first.ID, ConversationID: "2", Agent: "subagent:review", ParentConversationID: "1",
			Turn: 1, Steps: 1, ThinkingMs: 300, InputTokens: 40, OutputTokens: 10, CacheReadTokens: 160},
		{SessionID: second.ID, ConversationID: "1", Agent: "root", Turn: 1, Steps: 3, ToolCalls: 2, ToolMs: 50,
			ThinkingMs: 900, DurationMs: 1000, InputTokens: 60, OutputTokens: 30, CacheReadTokens: 240},
	}
	for i, run := range runs {
		run.StartedAtMs = int64(1000 + i)
		if err := store.RecordAgentRun(run); err != nil {
			t.Fatal(err)
		}
	}
	if err := store.RecordAgent(Agent{SessionID: first.ID, ConversationID: "2", ParentConversationID: "1",
		Name: "review", DependsOn: "build"}); err != nil {
		t.Fatal(err)
	}

	totals, err := store.AgentTotals()
	if err != nil {
		t.Fatal(err)
	}
	if totals.Sessions != 2 || totals.Conversations != 3 || totals.Runs != 3 {
		t.Fatalf("unexpected totals: %+v", totals)
	}
	if totals.Subagents != 1 || totals.SubagentSessions != 1 {
		t.Fatalf("unexpected subagent totals: %+v", totals)
	}
	if totals.Steps != 6 || totals.ToolCalls != 3 || totals.ToolMs != 80 || totals.SkillHits != 1 {
		t.Fatalf("unexpected work totals: %+v", totals)
	}
	if totals.PromptTokens() != 920 || totals.CacheReadTokens != 700 {
		t.Fatalf("unexpected token totals: %+v", totals)
	}
	if rate := totals.CacheHitRate(); rate < 0.76 || rate > 0.77 {
		t.Fatalf("cross-session cache hit rate = %v", rate)
	}

	sessions, err := store.SessionSummaries(0)
	if err != nil {
		t.Fatal(err)
	}
	if len(sessions) != 2 {
		t.Fatalf("want 2 session summaries, got %+v", sessions)
	}
	// Newest run first: the second session's run was written last.
	if sessions[0].SessionID != second.ID || sessions[1].SessionID != first.ID {
		t.Fatalf("session summaries not newest first: %+v", sessions)
	}
	if sessions[1].Conversations != 2 || sessions[1].Subagents != 1 || sessions[1].Runs != 2 {
		t.Fatalf("session should include its subagent: %+v", sessions[1])
	}
	if sessions[1].LastRunAtMs != 1001 {
		t.Fatalf("last run time = %d", sessions[1].LastRunAtMs)
	}

	subagents, err := store.SubagentSummaries(0)
	if err != nil {
		t.Fatal(err)
	}
	if len(subagents) != 1 {
		t.Fatalf("want 1 subagent, got %+v", subagents)
	}
	child := subagents[0]
	if child.Name != "review" || child.DependsOn != "build" || child.ParentConversationID != "1" {
		t.Fatalf("unexpected subagent record: %+v", child)
	}
	if child.SessionID != first.ID || child.Runs != 1 {
		t.Fatalf("subagent not tied to its session: %+v", child)
	}
	if child.CacheHitRate() != 0.8 {
		t.Fatalf("subagent cache hit rate = %v, want 0.8", child.CacheHitRate())
	}
}
