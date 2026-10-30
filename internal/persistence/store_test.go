package persistence

import (
	"context"
	"path/filepath"
	"testing"
	"time"

	"github.com/egoist/mygo/plugins/sqlite"
)

func openMemory(t *testing.T) *Store {
	t.Helper()
	store, err := OpenMemory(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = store.Close() })
	return store
}

func TestMigrateIsIdempotent(t *testing.T) {
	ctx := context.Background()
	store := openMemory(t)
	version, err := store.SchemaVersion(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if version != SchemaVersion {
		t.Fatalf("version = %d, want %d", version, SchemaVersion)
	}
	if err := store.Migrate(ctx); err != nil {
		t.Fatal(err)
	}
	if version, err = store.SchemaVersion(ctx); err != nil || version != SchemaVersion {
		t.Fatalf("version after a second migrate = %d, %v", version, err)
	}
}

func TestMigrateFromV1KeepsData(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "old.db")
	db, err := sqlite.Open(ctx, path, sqlite.OpenOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.Execute(ctx, `create table schema_migrations(version integer primary key, applied_at text not null)`); err != nil {
		t.Fatal(err)
	}
	statements := append([]sqlite.Statement(nil), migrations[0]...)
	statements = append(statements, sqlite.Statement{
		SQL:  `insert into schema_migrations(version, applied_at) values(1, ?)`,
		Args: []any{stamp(time.Now())},
	})
	if _, err := db.Transaction(ctx, statements); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Execute(ctx, `insert into workspaces(id, path, name, last_opened_at) values(?, ?, ?, ?)`,
		"w1", "/tmp/one", "one", stamp(time.Now())); err != nil {
		t.Fatal(err)
	}
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}

	store, err := Open(ctx, path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = store.Close() })
	if version, err := store.SchemaVersion(ctx); err != nil || version != SchemaVersion {
		t.Fatalf("version = %d, %v", version, err)
	}
	recent, err := store.RecentWorkspaces(ctx, 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(recent) != 1 || recent[0].Path != "/tmp/one" || recent[0].Name != "one" {
		t.Fatalf("row did not survive the migration: %+v", recent)
	}
}

func TestWorkspaceRoundTripUsesParameters(t *testing.T) {
	ctx := context.Background()
	store := openMemory(t)
	now := time.Now()
	// A path is user data: it must never be pasted into SQL.
	hostile := filepath.Join(t.TempDir(), "x'; drop table workspaces; --")
	if err := store.SaveWorkspace(ctx, hostile, now); err != nil {
		t.Fatal(err)
	}
	second := filepath.Join(t.TempDir(), "second")
	if err := store.SaveWorkspace(ctx, second, now.Add(time.Minute)); err != nil {
		t.Fatal(err)
	}
	if err := store.SaveWorkspace(ctx, second, now.Add(2*time.Minute)); err != nil {
		t.Fatal(err) // upsert, not a duplicate row
	}
	recent, err := store.RecentWorkspaces(ctx, 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(recent) != 2 {
		t.Fatalf("recent = %+v", recent)
	}
	if recent[0].Path != second {
		t.Errorf("newest first: got %q", recent[0].Path)
	}
	if recent[1].Path != hostile {
		t.Errorf("path round trip: got %q, want %q", recent[1].Path, hostile)
	}
}

func TestSessionRoundTrip(t *testing.T) {
	ctx := context.Background()
	store := openMemory(t)
	workspace := t.TempDir()
	session := Session{
		ID: "agent-1", AgentID: "agent-1", WorkspacePath: workspace,
		ACPSession: "acp-42", CanResume: true, UpdatedAt: time.Now(),
	}
	if err := store.SaveSession(ctx, session); err != nil {
		t.Fatal(err)
	}
	session.ACPSession = "acp-43"
	if err := store.SaveSession(ctx, session); err != nil {
		t.Fatal(err)
	}
	got, err := store.Sessions(ctx, workspace)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 || got[0].ACPSession != "acp-43" || !got[0].CanResume || got[0].AgentID != "agent-1" {
		t.Fatalf("sessions = %+v", got)
	}
	if other, err := store.Sessions(ctx, filepath.Join(workspace, "elsewhere")); err != nil || len(other) != 0 {
		t.Fatalf("sessions of another workspace = %+v, %v", other, err)
	}
}

func TestUIRoundTrip(t *testing.T) {
	ctx := context.Background()
	store := openMemory(t)
	if _, ok, err := store.UI(ctx, "layout:/tmp/one"); err != nil || ok {
		t.Fatalf("missing key = ok %v, err %v", ok, err)
	}
	if err := store.SaveUI(ctx, "layout:/tmp/one", []byte(`{"tabs":["a.go"]}`)); err != nil {
		t.Fatal(err)
	}
	blob, ok, err := store.UI(ctx, "layout:/tmp/one")
	if err != nil || !ok || string(blob) != `{"tabs":["a.go"]}` {
		t.Fatalf("blob = %q, ok %v, err %v", blob, ok, err)
	}
}

func TestPruneEventsHonoursBothLimits(t *testing.T) {
	ctx := context.Background()
	store := openMemory(t)
	now := time.Now()
	batch := make([]Event, 0, 20)
	for i := 0; i < 20; i++ {
		at := now.Add(-time.Duration(20-i) * time.Hour)
		batch = append(batch, Event{SessionID: "s1", Kind: "turn_end", Summary: "ok", At: at})
	}
	if err := store.AppendEvents(ctx, batch); err != nil {
		t.Fatal(err)
	}
	if count, err := store.CountEvents(ctx); err != nil || count != 20 {
		t.Fatalf("count = %d, %v", count, err)
	}
	if err := store.PruneEvents(ctx, 5, time.Hour); err != nil {
		t.Fatal(err)
	}
	count, err := store.CountEvents(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if count != 1 { // only the newest row is younger than an hour and within keep=5
		t.Fatalf("count after prune = %d, want 1", count)
	}
	if err := store.AppendEvents(ctx, batch[:2]); err != nil {
		t.Fatal(err)
	}
	if err := store.PruneEvents(ctx, 2, 24*365*time.Hour); err != nil {
		t.Fatal(err)
	}
	if count, err = store.CountEvents(ctx); err != nil || count != 2 {
		t.Fatalf("count after the keep limit = %d, %v", count, err)
	}
}

func TestOpenCreatesTheDirectory(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "nested", "dir", "omo.db")
	store, err := Open(ctx, path)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = store.Close() }()
	if err := store.SaveUI(ctx, "k", []byte("v")); err != nil {
		t.Fatal(err)
	}
}
