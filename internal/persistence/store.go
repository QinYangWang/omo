// Package persistence stores what the IDE must remember across restarts:
// workspaces, the UI layout, agent session mappings, permission grants and a
// bounded log of agent events.
//
// It holds no conversation: the transcript belongs to the agent, ACP has no
// client-side history. Rows here are metadata and short summaries.
//
// SQLite comes from MyGo's plugin (purego, no cgo). Every native library is
// loaded at first use, so Open failing is a supported outcome the caller must
// report rather than crash on (roadmap R6).
package persistence

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"github.com/egoist/mygo/plugins/sqlite"
)

// Workspace is one row of the recent-workspaces list.
type Workspace struct {
	Path       string
	Name       string
	LastOpened time.Time
}

// Session maps one IDE session to the ACP session an agent owns.
type Session struct {
	ID            string
	AgentID       string
	WorkspacePath string
	ACPSession    string
	CanResume     bool
	UpdatedAt     time.Time
}

// Event is one bounded diagnostic row: a kind and a short summary, never the
// full update.
type Event struct {
	SessionID string
	Kind      string
	Summary   string
	At        time.Time
}

// Store is one SQLite database. It is safe from any goroutine; calls serialize.
// Calls must stop before Close.
type Store struct {
	db *sqlite.DB
}

// migrations are applied in order; index+1 is the schema version. Never edit
// one that shipped: append.
var migrations = [][]sqlite.Statement{
	{{SQL: `create table if not exists workspaces(
		id text primary key,
		path text not null unique,
		name text not null,
		last_opened_at text not null)`}},
	{{SQL: `create table if not exists sessions(
		id text primary key,
		agent_id text not null,
		workspace_path text not null,
		acp_session text not null default '',
		can_resume integer not null default 0,
		updated_at text not null)`}},
	{{SQL: `create table if not exists agent_events(
		id integer primary key autoincrement,
		session_id text not null,
		kind text not null,
		at text not null,
		summary text not null)`}},
	{{SQL: `create table if not exists permission_grants(
		agent_id text not null,
		workspace_path text not null,
		risk integer not null,
		granted_at text not null,
		primary key(agent_id, workspace_path, risk))`}},
	{{SQL: `create table if not exists ui_state(
		key text primary key,
		value blob not null)`}},
	// v2: events are pruned by age, so the column needs its own index.
	{{SQL: `create index if not exists agent_events_at on agent_events(at)`}},
}

// SchemaVersion is the version Migrate brings a database to.
var SchemaVersion = len(migrations)

// Open opens (creating it when missing) the database at path and migrates it.
func Open(ctx context.Context, path string) (*Store, error) {
	if dir := filepath.Dir(path); dir != "" {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			return nil, fmt.Errorf("persistence: create %s: %w", dir, err)
		}
	}
	db, err := sqlite.Open(ctx, path, sqlite.OpenOptions{})
	if err != nil {
		return nil, fmt.Errorf("persistence: %w", err)
	}
	s := &Store{db: db}
	if err := s.Migrate(ctx); err != nil {
		_ = db.Close()
		return nil, err
	}
	return s, nil
}

// OpenMemory opens a throwaway database, for tests.
func OpenMemory(ctx context.Context) (*Store, error) {
	db, err := sqlite.Open(ctx, ":memory:", sqlite.OpenOptions{})
	if err != nil {
		return nil, fmt.Errorf("persistence: %w", err)
	}
	s := &Store{db: db}
	if err := s.Migrate(ctx); err != nil {
		_ = db.Close()
		return nil, err
	}
	return s, nil
}

// Migrate applies every migration this build knows that the database lacks, one
// transaction each, so a failed migration leaves the previous version intact.
func (s *Store) Migrate(ctx context.Context) error {
	if _, err := s.db.Execute(ctx, `create table if not exists schema_migrations(
		version integer primary key,
		applied_at text not null)`); err != nil {
		return fmt.Errorf("persistence: create schema_migrations: %w", err)
	}
	current, err := s.SchemaVersion(ctx)
	if err != nil {
		return err
	}
	for version := current; version < SchemaVersion; version++ {
		statements := append([]sqlite.Statement(nil), migrations[version]...)
		statements = append(statements, sqlite.Statement{
			SQL:  `insert into schema_migrations(version, applied_at) values(?, ?)`,
			Args: []any{version + 1, stamp(time.Now())},
		})
		if _, err := s.db.Transaction(ctx, statements); err != nil {
			return fmt.Errorf("persistence: migrate to v%d: %w", version+1, err)
		}
	}
	return nil
}

// SchemaVersion reports the highest migration the database has applied.
func (s *Store) SchemaVersion(ctx context.Context) (int, error) {
	rows, err := s.db.Query(ctx, `select coalesce(max(version), 0) from schema_migrations`)
	if err != nil {
		return 0, fmt.Errorf("persistence: read schema version: %w", err)
	}
	if len(rows.Values) != 1 || len(rows.Values[0]) != 1 {
		return 0, errors.New("persistence: schema version query returned no rows")
	}
	version, ok := rows.Values[0][0].(int64)
	if !ok {
		return 0, fmt.Errorf("persistence: schema version is %T", rows.Values[0][0])
	}
	return int(version), nil
}

// SaveWorkspace records that path was opened at now, creating it when new.
func (s *Store) SaveWorkspace(ctx context.Context, path string, now time.Time) error {
	path = filepath.Clean(path)
	_, err := s.db.Execute(ctx, `insert into workspaces(id, path, name, last_opened_at) values(?, ?, ?, ?)
		on conflict(path) do update set last_opened_at = excluded.last_opened_at`,
		path, path, filepath.Base(path), stamp(now))
	if err != nil {
		return fmt.Errorf("persistence: save workspace: %w", err)
	}
	return nil
}

// RecentWorkspaces returns the most recently opened workspaces, newest first.
func (s *Store) RecentWorkspaces(ctx context.Context, limit int) ([]Workspace, error) {
	rows, err := s.db.Query(ctx, `select path, name, last_opened_at from workspaces
		order by last_opened_at desc limit ?`, limit)
	if err != nil {
		return nil, fmt.Errorf("persistence: recent workspaces: %w", err)
	}
	out := make([]Workspace, 0, len(rows.Values))
	for _, row := range rows.Values {
		out = append(out, Workspace{
			Path:       asString(row[0]),
			Name:       asString(row[1]),
			LastOpened: parseTime(asString(row[2])),
		})
	}
	return out, nil
}

// SaveSession writes one session mapping.
func (s *Store) SaveSession(ctx context.Context, session Session) error {
	_, err := s.db.Execute(ctx, `insert into sessions(id, agent_id, workspace_path, acp_session, can_resume, updated_at)
		values(?, ?, ?, ?, ?, ?)
		on conflict(id) do update set acp_session = excluded.acp_session,
			can_resume = excluded.can_resume, updated_at = excluded.updated_at`,
		session.ID, session.AgentID, filepath.Clean(session.WorkspacePath), session.ACPSession,
		boolInt(session.CanResume), stamp(session.UpdatedAt))
	if err != nil {
		return fmt.Errorf("persistence: save session: %w", err)
	}
	return nil
}

// Sessions returns every session mapping of one workspace.
func (s *Store) Sessions(ctx context.Context, workspacePath string) ([]Session, error) {
	rows, err := s.db.Query(ctx, `select id, agent_id, workspace_path, acp_session, can_resume, updated_at
		from sessions where workspace_path = ?`, filepath.Clean(workspacePath))
	if err != nil {
		return nil, fmt.Errorf("persistence: sessions: %w", err)
	}
	out := make([]Session, 0, len(rows.Values))
	for _, row := range rows.Values {
		out = append(out, Session{
			ID:            asString(row[0]),
			AgentID:       asString(row[1]),
			WorkspacePath: asString(row[2]),
			ACPSession:    asString(row[3]),
			CanResume:     asInt(row[4]) != 0,
			UpdatedAt:     parseTime(asString(row[5])),
		})
	}
	return out, nil
}

// SaveUI stores one UI blob, such as a workspace's open tabs.
func (s *Store) SaveUI(ctx context.Context, key string, value []byte) error {
	_, err := s.db.Execute(ctx, `insert into ui_state(key, value) values(?, ?)
		on conflict(key) do update set value = excluded.value`, key, value)
	if err != nil {
		return fmt.Errorf("persistence: save ui state: %w", err)
	}
	return nil
}

// UI returns a stored UI blob.
func (s *Store) UI(ctx context.Context, key string) ([]byte, bool, error) {
	rows, err := s.db.Query(ctx, `select value from ui_state where key = ?`, key)
	if err != nil {
		return nil, false, fmt.Errorf("persistence: read ui state: %w", err)
	}
	if len(rows.Values) == 0 {
		return nil, false, nil
	}
	blob, ok := rows.Values[0][0].([]byte)
	if !ok {
		return nil, false, fmt.Errorf("persistence: ui state %q is %T", key, rows.Values[0][0])
	}
	return blob, true, nil
}

// AppendEvents writes a batch of diagnostic events in one transaction.
func (s *Store) AppendEvents(ctx context.Context, batch []Event) error {
	if len(batch) == 0 {
		return nil
	}
	statements := make([]sqlite.Statement, 0, len(batch))
	for _, ev := range batch {
		statements = append(statements, sqlite.Statement{
			SQL:  `insert into agent_events(session_id, kind, at, summary) values(?, ?, ?, ?)`,
			Args: []any{ev.SessionID, ev.Kind, stamp(ev.At), ev.Summary},
		})
	}
	if _, err := s.db.Transaction(ctx, statements); err != nil {
		return fmt.Errorf("persistence: append events: %w", err)
	}
	return nil
}

// CountEvents is how many event rows the database holds.
func (s *Store) CountEvents(ctx context.Context) (int, error) {
	rows, err := s.db.Query(ctx, `select count(*) from agent_events`)
	if err != nil {
		return 0, fmt.Errorf("persistence: count events: %w", err)
	}
	if len(rows.Values) != 1 {
		return 0, errors.New("persistence: count query returned no rows")
	}
	return asInt(rows.Values[0][0]), nil
}

// PruneEvents deletes events older than maxAge and then everything but the
// newest keep, so both limits hold.
func (s *Store) PruneEvents(ctx context.Context, keep int, maxAge time.Duration) error {
	if keep < 0 {
		keep = 0
	}
	if _, err := s.db.Execute(ctx, `delete from agent_events where at < ?`, stamp(time.Now().Add(-maxAge))); err != nil {
		return fmt.Errorf("persistence: prune events by age: %w", err)
	}
	if _, err := s.db.Execute(ctx,
		`delete from agent_events where id not in (select id from agent_events order by id desc limit ?)`, keep); err != nil {
		return fmt.Errorf("persistence: prune old events: %w", err)
	}
	return nil
}

// Close releases the database. Repeated calls are harmless.
func (s *Store) Close() error { return s.db.Close() }

// timeLayout has a fixed width so that text comparison of the column orders
// the way time does, which PruneEvents relies on.
const timeLayout = "2006-01-02T15:04:05.000000000Z07:00"

func stamp(t time.Time) string { return t.UTC().Format(timeLayout) }

func parseTime(value string) time.Time {
	t, err := time.Parse(timeLayout, value)
	if err != nil {
		return time.Time{}
	}
	return t
}

func boolInt(b bool) int64 {
	if b {
		return 1
	}
	return 0
}

func asString(v any) string {
	if text, ok := v.(string); ok {
		return text
	}
	return ""
}

func asInt(v any) int {
	if n, ok := v.(int64); ok {
		return int(n)
	}
	return 0
}
