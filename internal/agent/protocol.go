package agent

import (
	"context"
	"encoding/json"
	"fmt"
	"path/filepath"
	"strings"
	"time"

	acp "github.com/caelis-labs/acp-go-sdk"
)

const (
	maxToolCommandItems = 9 // Program plus eight arguments.
	maxToolPathItems    = 32
)

func (p *peer) handle(ctx context.Context, method string, params json.RawMessage) (any, *acp.RequestError) {
	switch method {
	case acp.ClientMethodSessionUpdate:
		p.handleUpdate(params)
		return nil, nil
	case acp.ClientMethodSessionRequestPermission:
		return p.handlePermission(ctx, params)
	default:
		p.manager.diagnose("unsupported inbound ACP method "+method, "")
		return nil, acp.NewMethodNotFound(method)
	}
}

func (p *peer) handleUpdate(raw json.RawMessage) {
	var notification struct {
		SessionID string          `json:"sessionId"`
		Update    json.RawMessage `json:"update"`
	}
	if err := json.Unmarshal(raw, &notification); err != nil || notification.SessionID == "" || len(notification.Update) == 0 {
		p.manager.diagnose("malformed session/update", string(raw))
		return
	}
	m := p.manager
	m.mu.Lock()
	current := m.peer == p && !p.stopping.Load()
	sessionMatch := notification.SessionID != "" && notification.SessionID == m.sessionID
	accept := current && sessionMatch && (m.state == StateStarting || m.active && !m.cancelRequested)
	generation := p.generation
	turn := uint64(0)
	if m.active {
		turn = m.turn
	}
	m.mu.Unlock()
	if !accept {
		m.diagnose("late or unrelated session/update for "+notification.SessionID, string(raw))
		return
	}

	var envelope struct {
		Kind string `json:"sessionUpdate"`
	}
	if err := json.Unmarshal(notification.Update, &envelope); err != nil {
		m.diagnose("malformed session/update payload", string(raw))
		return
	}
	switch envelope.Kind {
	case "agent_message_chunk", "agent_thought_chunk":
		var chunk struct {
			Content struct {
				Type string `json:"type"`
				Text string `json:"text"`
			} `json:"content"`
			MessageID string `json:"messageId"`
		}
		if err := json.Unmarshal(notification.Update, &chunk); err != nil || chunk.Content.Type != "text" {
			m.diagnose("unsupported content in "+envelope.Kind, string(notification.Update))
			return
		}
		kind := EventText
		if envelope.Kind == "agent_thought_chunk" {
			kind = EventThought
		}
		m.queueText(p, generation, turn, kind, chunk.MessageID, chunk.Content.Text)
	case "tool_call", "tool_call_update":
		var call acp.ToolCallUpdate
		if err := json.Unmarshal(notification.Update, &call); err != nil || call.ToolCallId == "" {
			m.diagnose("malformed "+envelope.Kind, string(notification.Update))
			return
		}
		title := ""
		if call.Title != nil {
			title = *call.Title
		}
		if title == "" && call.Name != nil {
			title = *call.Name
		}
		status := ""
		if call.Status != nil {
			status = string(*call.Status)
		}
		kind, paths, command, input := toolCallDetails(call, p.cwd)
		m.emitTurn(p, generation, turn, Event{
			Kind: EventTool, Title: title, Text: status, KindDetail: kind,
			ToolCallID: string(call.ToolCallId), Paths: paths, Command: command, Input: input,
			Raw: cleanDiagnostic(string(notification.Update)),
		})
	case "plan":
		var plan struct {
			Entries []struct {
				Content string `json:"content"`
				Status  string `json:"status"`
			} `json:"entries"`
		}
		if err := json.Unmarshal(notification.Update, &plan); err != nil {
			m.diagnose("malformed plan", string(notification.Update))
			return
		}
		var text strings.Builder
		for i, entry := range plan.Entries {
			if i == 100 {
				text.WriteString("…\n")
				break
			}
			fmt.Fprintf(&text, "- [%s] %s\n", entry.Status, entry.Content)
		}
		m.emitTurn(p, generation, turn, Event{Kind: EventPlan, Title: "Plan updated", Text: text.String(), Raw: cleanDiagnostic(string(notification.Update))})
	case "user_message_chunk":
		// The application already owns the user prompt; do not duplicate it in the transcript.
	default:
		m.diagnose("unknown or unsupported session/update variant "+envelope.Kind, string(notification.Update))
	}
}

func toolCallDetails(call acp.ToolCallUpdate, cwd string) (string, []string, []string, string) {
	kind := ""
	if call.Kind != nil {
		kind = string(*call.Kind)
	}
	paths := make([]string, 0, len(call.Locations))
	for i, location := range call.Locations {
		if i == maxToolPathItems {
			paths = append(paths, "…")
			break
		}
		paths = append(paths, workspaceDisplayPath(cwd, location.Path))
	}
	command, input := toolInputPreview(call.RawInput)
	return kind, paths, command, input
}

func workspaceDisplayPath(cwd, path string) string {
	if !filepath.IsAbs(path) {
		path = filepath.Join(cwd, path)
	}
	absolute, err := filepath.Abs(path)
	if err != nil {
		return "<external>"
	}
	relative, err := filepath.Rel(cwd, absolute)
	if err != nil || relative == ".." || strings.HasPrefix(relative, ".."+string(filepath.Separator)) || filepath.IsAbs(relative) {
		return "<external>"
	}
	return filepath.ToSlash(relative)
}

func toolInputPreview(raw any) ([]string, string) {
	if raw == nil {
		return nil, ""
	}
	if object, ok := raw.(map[string]any); ok {
		for _, key := range []string{"command", "argv"} {
			value, ok := object[key]
			if !ok {
				continue
			}
			if command, input, ok := commandInput(value); ok {
				return command, input
			}
		}
	}
	if command, input, ok := commandInput(raw); ok {
		return command, input
	}
	encoded, err := json.Marshal(withoutEnvironment(raw))
	if err != nil {
		return nil, ""
	}
	return nil, cleanDiagnostic(string(encoded))
}

func commandInput(value any) ([]string, string, bool) {
	switch value := value.(type) {
	case string:
		return nil, cleanDiagnostic(value), true
	case []string:
		return boundCommand(value), "", true
	case []any:
		command := make([]string, len(value))
		for i, item := range value {
			text, ok := item.(string)
			if !ok {
				return nil, "", false
			}
			command[i] = text
		}
		return boundCommand(command), "", true
	default:
		return nil, "", false
	}
}

func boundCommand(command []string) []string {
	if len(command) <= maxToolCommandItems {
		return append([]string(nil), command...)
	}
	bounded := append([]string(nil), command[:maxToolCommandItems]...)
	return append(bounded, "…")
}

func withoutEnvironment(value any) any {
	switch value := value.(type) {
	case map[string]any:
		clean := make(map[string]any, len(value))
		for key, item := range value {
			if strings.EqualFold(key, "env") || strings.EqualFold(key, "environment") {
				continue
			}
			clean[key] = withoutEnvironment(item)
		}
		return clean
	case []any:
		clean := make([]any, len(value))
		for i, item := range value {
			clean[i] = withoutEnvironment(item)
		}
		return clean
	default:
		return value
	}
}

func (p *peer) handlePermission(ctx context.Context, raw json.RawMessage) (any, *acp.RequestError) {
	var request acp.RequestPermissionRequest
	if err := json.Unmarshal(raw, &request); err != nil {
		return nil, acp.NewInvalidParams(map[string]any{"error": err.Error()})
	}
	if err := request.Validate(); err != nil {
		return nil, acp.NewInvalidParams(map[string]any{"error": err.Error()})
	}
	if len(request.Options) == 0 {
		return nil, acp.NewInvalidParams(map[string]any{"error": "at least one permission option is required"})
	}
	m := p.manager
	m.mu.Lock()
	if m.peer != p || p.stopping.Load() || !m.active || m.cancelRequested || string(request.SessionId) != m.sessionID {
		m.mu.Unlock()
		return permissionResponse(acp.NewRequestPermissionOutcomeCancelled()), nil
	}
	m.nextRequest++
	requestID := fmt.Sprintf("%d-%d", p.generation, m.nextRequest)
	pending := &pendingPermission{
		peer:       p,
		generation: p.generation,
		turn:       m.turn,
		toolCallID: string(request.ToolCall.ToolCallId),
		options:    make(map[string]struct{}, len(request.Options)),
		result:     make(chan permissionResult, 1),
	}
	options := make([]PermissionOption, 0, len(request.Options))
	for _, option := range request.Options {
		id := string(option.OptionId)
		if id == "" {
			m.mu.Unlock()
			return nil, acp.NewInvalidParams(map[string]any{"error": "empty permission option id"})
		}
		if _, duplicate := pending.options[id]; duplicate {
			m.mu.Unlock()
			return nil, acp.NewInvalidParams(map[string]any{"error": "duplicate permission option id"})
		}
		pending.options[id] = struct{}{}
		if pending.rejectID == "" && (option.Kind == "reject_once" || option.Kind == "reject_always") {
			pending.rejectID = id
		}
		options = append(options, PermissionOption{ID: id, Name: option.Name, Kind: string(option.Kind)})
	}
	m.pending[requestID] = pending
	generation := p.generation
	turn := m.turn
	m.mu.Unlock()

	title := ""
	if request.ToolCall.Title != nil {
		title = *request.ToolCall.Title
	}
	if title == "" && request.ToolCall.Name != nil {
		title = *request.ToolCall.Name
	}
	kind, paths, command, input := toolCallDetails(request.ToolCall, p.cwd)
	if !m.emitTurn(p, generation, turn, Event{
		Kind: EventPermission, Title: title, ToolCallID: string(request.ToolCall.ToolCallId),
		RequestID: requestID, Options: options, KindDetail: kind, Paths: paths, Command: command, Input: input,
		Raw: cleanDiagnostic(string(raw)),
	}) {
		m.completePermission(requestID, pending, permissionResult{cancel: true})
	}

	timer := time.NewTimer(m.permissionTimeout)
	defer timer.Stop()
	select {
	case result := <-pending.result:
		return permissionResultResponse(result), nil
	case <-timer.C:
		result := permissionResult{cancel: true}
		if pending.rejectID != "" {
			result = permissionResult{optionID: pending.rejectID}
		}
		if m.completePermission(requestID, pending, result) {
			m.diagnose("permission request timed out; denied", string(raw))
		}
		result = <-pending.result
		return permissionResultResponse(result), nil
	case <-ctx.Done():
		m.completePermission(requestID, pending, permissionResult{cancel: true})
		result := <-pending.result
		return permissionResultResponse(result), nil
	case <-p.conn.Done():
		m.completePermission(requestID, pending, permissionResult{cancel: true})
		result := <-pending.result
		return permissionResultResponse(result), nil
	}
}

func permissionResultResponse(result permissionResult) any {
	if result.cancel {
		return permissionResponse(acp.NewRequestPermissionOutcomeCancelled())
	}
	return permissionResponse(acp.NewRequestPermissionOutcomeSelected(acp.PermissionOptionId(result.optionID)))
}

func permissionResponse(outcome acp.RequestPermissionOutcome) acp.RequestPermissionResponse {
	return acp.RequestPermissionResponse{Outcome: outcome}
}

func (m *Manager) diagnose(message, raw string) {
	message = cleanDiagnostic(message)
	if raw != "" {
		message += " | raw=" + cleanDiagnostic(raw)
	}
	m.recordDiagnostic(message)
	m.emit(Event{Kind: EventDiagnostic, Text: message, Raw: cleanDiagnostic(raw)})
}

func (m *Manager) recordDiagnostic(message string) {
	m.mu.Lock()
	if len(m.diagnostics) == diagnosticLimit {
		copy(m.diagnostics, m.diagnostics[1:])
		m.diagnostics[len(m.diagnostics)-1] = message
	} else {
		m.diagnostics = append(m.diagnostics, message)
	}
	m.mu.Unlock()
}
