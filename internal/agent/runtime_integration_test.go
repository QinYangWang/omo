package agent

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// These tests use real model accounts and real ACP runtimes. They are opt-in:
//
//	OMO_ACP_INTEGRATION=1 \
//	OMO_CODEX_ACP=$APPDATA/npm/node_modules/@agentclientprotocol/codex-acp/dist/index.js \
//	OMO_PI_ACP=$APPDATA/npm/node_modules/pi-acp/dist/index.js \
//	go test -v ./internal/agent -run TestRealACP -timeout 5m
func TestRealACPCodex(t *testing.T) { testRealACP(t, "codex", "OMO_CODEX_ACP") }
func TestRealACPPi(t *testing.T)    { testRealACP(t, "pi", "OMO_PI_ACP") }

func testRealACP(t *testing.T, name, scriptEnv string) {
	t.Helper()
	if os.Getenv("OMO_ACP_INTEGRATION") == "" {
		t.Skip("set OMO_ACP_INTEGRATION=1 to run real ACP runtimes")
	}
	script := os.Getenv(scriptEnv)
	if script == "" {
		t.Skip("set " + scriptEnv + " to the installed adapter's dist/index.js")
	}
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("node is not installed")
	}
	def, err := Approve(Definition{
		ID: "integration-" + name, Name: name, Executable: node, Args: []string{script}, Trusted: true,
		Env: []string{"INITIAL_AGENT_MODE=read-only"},
	})
	if err != nil {
		t.Fatal(err)
	}
	workspace := t.TempDir()
	m := NewManager()
	events := collectEvents(m)
	t.Cleanup(events.close)
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = m.Close(ctx)
	})
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer cancel()
	if err := m.Start(ctx, def, workspace); err != nil {
		t.Fatalf("%s Start: %v; diagnostics: %v", name, err, m.Diagnostics())
	}
	state, sessionID, canLoad := m.Snapshot()
	if state != StateReady || sessionID == "" {
		t.Fatalf("%s initial snapshot = %q, %q", name, state, sessionID)
	}
	t.Logf("%s ready: session=%s loadSession=%v", name, sessionID, canLoad)

	promptCtx, promptCancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer promptCancel()
	want := "OMO_" + strings.ToUpper(name) + "_OK"
	if err := m.Prompt(promptCtx, "Reply with exactly "+want+" and do not use any tools."); err != nil {
		t.Fatalf("%s Prompt: %v; diagnostics: %v", name, err, m.Diagnostics())
	}
	events.waitFor(t, func(e Event) bool { return e.Kind == EventTurnEnd && e.StopReason != "" })
	var response strings.Builder
	for _, event := range events.all() {
		if event.Kind == EventText {
			response.WriteString(event.Text)
		}
	}
	if !strings.Contains(response.String(), want) {
		t.Fatalf("%s response = %q, want substring %q", name, response.String(), want)
	}
	t.Logf("%s streamed response: %s", name, strings.TrimSpace(response.String()))

	if err := m.Restart(ctx, def, workspace); err != nil {
		t.Fatalf("%s Restart: %v; diagnostics: %v", name, err, m.Diagnostics())
	}
	_, restoredID, restoredCanLoad := m.Snapshot()
	if canLoad && restoredID != sessionID {
		t.Fatalf("%s restore changed session from %q to %q", name, sessionID, restoredID)
	}
	if !canLoad && restoredID == sessionID {
		t.Fatalf("%s did not replace a session without loadSession", name)
	}
	t.Logf("%s restart complete: session=%s loadSession=%v", name, restoredID, restoredCanLoad)
	if name == "codex" {
		testRealACPPermission(t, m, events, workspace, name)
	} else {
		t.Log("pi-acp 0.0.34 does not forward bash/write tool permission requests; fake-agent permission tests cover the client path")
	}

	longCtx, longCancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer longCancel()
	turnDone := make(chan error, 1)
	go func() {
		turnDone <- m.Prompt(longCtx, "Write a very long essay about Go concurrency. Do not use tools.")
	}()
	waitUntil(t, func() bool { state, _, _ := m.Snapshot(); return state == StatePrompting })
	cancelCtx, cancelTurn := context.WithTimeout(context.Background(), 4*time.Second)
	defer cancelTurn()
	startedCancel := time.Now()
	if err := m.Cancel(cancelCtx); err != nil {
		t.Fatalf("%s Cancel: %v; diagnostics: %v", name, err, m.Diagnostics())
	}
	turnErr := error(nil)
	select {
	case turnErr = <-turnDone:
	case <-time.After(6 * time.Second):
		t.Fatalf("%s turn did not finish after cancellation", name)
	}
	if elapsed := time.Since(startedCancel); elapsed > 6*time.Second {
		t.Fatalf("%s cancellation took %v", name, elapsed)
	}
	state, _, _ = m.Snapshot()
	switch {
	case turnErr == nil || errors.Is(turnErr, context.Canceled):
		if state != StateReady {
			t.Fatalf("%s normal cancellation left state %q", name, state)
		}
	case errors.Is(turnErr, ErrTurnUnknown):
		if state != StateError {
			t.Fatalf("%s timed-out cancellation left state %q, want error", name, state)
		}
		t.Logf("%s ignored cancellation; connection was torn down within the deadline", name)
	default:
		t.Fatalf("%s cancelled Prompt: %v", name, turnErr)
	}
	t.Logf("%s cancellation completed in %v", name, time.Since(startedCancel))
}

func testRealACPPermission(t *testing.T, m *Manager, events *eventCollector, workspace, name string) {
	t.Helper()
	turnDone := make(chan error, 1)
	go func() {
		turnDone <- m.Prompt(context.Background(), "Before doing anything else, use your bash/shell tool (not write or edit) to run a command that creates denied.txt with the content NO. You must use bash/shell.")
	}()
	permission := waitRuntimeEvent(t, events, func(e Event) bool { return e.Kind == EventPermission }, 45*time.Second)
	if permission.KindDetail == "" && len(permission.Paths) == 0 && len(permission.Command) == 0 && permission.Input == "" {
		t.Fatalf("%s permission lacked operation details: %+v", name, permission)
	}
	rejectID := ""
	for _, option := range permission.Options {
		if option.Kind == "reject_once" {
			rejectID = option.ID
			break
		}
	}
	if rejectID == "" {
		t.Fatalf("%s permission had no reject_once option: %+v", name, permission.Options)
	}
	if !m.Resolve(permission.RequestID, rejectID) {
		t.Fatalf("%s could not reject permission %q", name, permission.RequestID)
	}
	select {
	case err := <-turnDone:
		if errors.Is(err, ErrTurnUnknown) {
			t.Fatalf("%s rejection ended in an unknown turn: %v", name, err)
		}
		t.Logf("%s permission rejected; turn result: %v", name, err)
	case <-time.After(20 * time.Second):
		t.Fatalf("%s turn did not finish after permission rejection", name)
	}
	if _, err := os.Stat(filepath.Join(workspace, "denied.txt")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("%s created denied.txt despite rejection (stat error %v)", name, err)
	}
}

func waitRuntimeEvent(t *testing.T, events *eventCollector, match func(Event) bool, timeout time.Duration) Event {
	t.Helper()
	deadline := time.NewTimer(timeout)
	defer deadline.Stop()
	for {
		for _, event := range events.all() {
			if match(event) {
				return event
			}
		}
		select {
		case <-events.notify:
		case <-deadline.C:
			t.Fatalf("runtime event not found; events = %#v", events.all())
		}
	}
}
