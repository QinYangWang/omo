package commands

import (
	"context"
	"errors"
	"testing"
)

func TestRegisterAndRun(t *testing.T) {
	r := NewRegistry()
	ran := ""
	if err := r.Register(Command{ID: "a.run", Title: "a", Run: func(context.Context) error {
		ran = "a"
		return nil
	}}); err != nil {
		t.Fatal(err)
	}
	if err := r.Register(Command{ID: "b.run", Title: "b", Run: func(context.Context) error { return nil }}); err != nil {
		t.Fatal(err)
	}
	if err := r.Run(context.Background(), "a.run"); err != nil || ran != "a" {
		t.Fatalf("ran=%q err=%v", ran, err)
	}
	list := r.List()
	if len(list) != 2 || list[0].ID != "a.run" || list[1].ID != "b.run" {
		t.Fatalf("list order = %v", list)
	}
}

func TestRegisterRejectsIncompleteAndDuplicate(t *testing.T) {
	r := NewRegistry()
	if err := r.Register(Command{Title: "no id"}); !errors.Is(err, ErrIncomplete) {
		t.Fatalf("want ErrIncomplete, got %v", err)
	}
	run := func(context.Context) error { return nil }
	if err := r.Register(Command{ID: "x", Run: run}); err != nil {
		t.Fatal(err)
	}
	if err := r.Register(Command{ID: "x", Run: run}); !errors.Is(err, ErrDuplicateID) {
		t.Fatalf("want ErrDuplicateID, got %v", err)
	}
}

func TestRunUnknownAndDisabled(t *testing.T) {
	r := NewRegistry()
	if err := r.Run(context.Background(), "nope"); !errors.Is(err, ErrUnknown) {
		t.Fatalf("want ErrUnknown, got %v", err)
	}
	disabled := false
	if err := r.Register(Command{ID: "x", Run: func(context.Context) error { return nil }, Enabled: func() bool { return disabled }}); err != nil {
		t.Fatal(err)
	}
	if err := r.Run(context.Background(), "x"); !errors.Is(err, ErrDisabled) {
		t.Fatalf("want ErrDisabled, got %v", err)
	}
}
