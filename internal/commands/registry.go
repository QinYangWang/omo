// Package commands is the IDE's command registry: buttons, menus, key bindings
// and (later) the command palette all reach the same capability through one ID
// and one execution path, so a feature never grows three implementations.
//
// Registration happens during startup only; once registered the registry is
// read-only and safe to call from any goroutine.
package commands

import (
	"context"
	"errors"
	"fmt"
	"sort"
)

// ID is a command's stable identifier, such as "workspace.open".
type ID string

// Command is one command. A nil Enabled means always available. Run executes
// synchronously on the caller's goroutine; the caller decides whether to move
// it to a goroutine of its own.
//
// Title is an i18n message key, not a display string: the view translates it
// with the window's locale.
type Command struct {
	ID      ID
	Title   string
	Key     string // shortcut hint for display; the binding lives in the view
	Enabled func() bool
	Run     func(ctx context.Context) error
}

var (
	ErrUnknown     = errors.New("commands: unknown command")
	ErrDisabled    = errors.New("commands: command is disabled")
	ErrDuplicateID = errors.New("commands: duplicate command id")
	ErrIncomplete  = errors.New("commands: command needs an ID and a Run function")
)

// Registry is a table of commands.
type Registry struct {
	byID  map[ID]Command
	order []ID
}

// NewRegistry returns an empty table.
func NewRegistry() *Registry {
	return &Registry{byID: make(map[ID]Command)}
}

// Register adds a command, reporting a duplicate ID or a missing field.
func (r *Registry) Register(c Command) error {
	if c.ID == "" || c.Run == nil {
		return ErrIncomplete
	}
	if _, ok := r.byID[c.ID]; ok {
		return fmt.Errorf("%w: %s", ErrDuplicateID, c.ID)
	}
	r.byID[c.ID] = c
	r.order = append(r.order, c.ID)
	return nil
}

// List returns every command sorted by ID, which keeps the command palette's
// output stable.
func (r *Registry) List() []Command {
	out := make([]Command, 0, len(r.order))
	for _, id := range r.order {
		out = append(out, r.byID[id])
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out
}

// Lookup finds one command.
func (r *Registry) Lookup(id ID) (Command, bool) {
	c, ok := r.byID[id]
	return c, ok
}

// Run executes a command, handling "unknown" and "disabled" in one place.
func (r *Registry) Run(ctx context.Context, id ID) error {
	c, ok := r.byID[id]
	if !ok {
		return fmt.Errorf("%w: %s", ErrUnknown, id)
	}
	if c.Enabled != nil && !c.Enabled() {
		return fmt.Errorf("%w: %s", ErrDisabled, id)
	}
	return c.Run(ctx)
}
