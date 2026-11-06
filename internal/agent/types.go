package agent

import (
	"errors"
	"time"
)

// Definition describes one directly executed ACP agent. Env entries use KEY=value form.
type Definition struct {
	ID                 string   `json:"id"`
	Name               string   `json:"name"`
	Executable         string   `json:"executable"`
	Args               []string `json:"args,omitempty"`
	Env                []string `json:"env,omitempty"`
	Trusted            bool     `json:"trusted"`
	ApprovedExecutable string   `json:"approvedExecutable,omitempty"`
	ApprovedSHA256     string   `json:"approvedSHA256,omitempty"`
	ApprovedArgs       []string `json:"approvedArgs,omitempty"`
	ApprovedEnv        []string `json:"approvedEnv,omitempty"`
}

// State is the manager's combined process and session state.
type State string

const (
	StateDisconnected State = "disconnected"
	StateStarting     State = "starting"
	StateReady        State = "ready"
	StatePrompting    State = "prompting"
	StateCancelling   State = "cancelling"
	StateError        State = "error"
)

// EventKind identifies a normalized agent event.
type EventKind string

const (
	EventState           EventKind = "state"
	EventText            EventKind = "text"
	EventThought         EventKind = "thought"
	EventTool            EventKind = "tool"
	EventPlan            EventKind = "plan"
	EventPermission      EventKind = "permission"
	EventPermissionEnd   EventKind = "permission_end"
	EventDiagnostic      EventKind = "diagnostic"
	EventTurnEnd         EventKind = "turn_end"
	EventSessionReplaced EventKind = "session_replaced"
)

// PermissionOption is an agent-provided choice; Resolve accepts its ID verbatim.
type PermissionOption struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	Kind string `json:"kind"`
}

// PlanEntry is one step of an ACP plan: what the agent means to do and how far
// it got (pending, in_progress or completed).
type PlanEntry struct {
	Content  string
	Status   string
	Priority string
}

// Event is the SDK-independent stream consumed by the application.
type Event struct {
	Kind       EventKind
	State      State
	Generation uint64
	Turn       uint64
	Text       string
	Title      string
	KindDetail string
	ToolCallID string
	RequestID  string
	Paths      []string
	Command    []string
	Input      string
	Raw        string
	StopReason string
	Options    []PermissionOption
	// Plan is the whole plan of an EventPlan: ACP sends the full list each
	// time, so it replaces the previous one.
	Plan []PlanEntry
	At   time.Time
}

var (
	ErrUntrusted      = errors.New("agent: definition is not trusted")
	ErrTrustChanged   = errors.New("agent: trusted launch settings or executable changed")
	ErrBusy           = errors.New("agent: an operation is already active")
	ErrAlreadyStarted = errors.New("agent: already started; use Restart")
	ErrNotReady       = errors.New("agent: no ready session")
	ErrTurnUnknown    = errors.New("agent: turn outcome unknown")
)
