// Package chat keeps the app's chat sessions and message history in SQLite.
//
// Pi Durable keeps the agent transcript in its own SQLite database per
// session (see internal/runtime/moejs); this store holds what the sidebar
// and the window need before an agent runtime is open.
package chat

import (
	"database/sql"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"time"

	_ "modernc.org/sqlite"
)

type Session struct {
	ID        string
	Title     string
	Workspace string
	CreatedAt time.Time
	UpdatedAt time.Time
}

type Message struct {
	ID        int64
	SessionID string
	Role      string
	Text      string
	CreatedAt time.Time
}

type Store struct {
	db  *sql.DB
	dir string
}

func Open(dir string) (*Store, error) {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, err
	}
	db, err := sql.Open("sqlite", filepath.Join(dir, "app.db"))
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)
	store := &Store{db: db, dir: dir}
	if err := store.migrate(); err != nil {
		db.Close()
		return nil, err
	}
	return store, nil
}

func (s *Store) migrate() error {
	_, err := s.db.Exec(`
PRAGMA journal_mode=WAL;
CREATE TABLE IF NOT EXISTS sessions (
	id TEXT PRIMARY KEY,
	title TEXT NOT NULL DEFAULT 'New chat',
	workspace TEXT NOT NULL,
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS messages (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
	role TEXT NOT NULL,
	text TEXT NOT NULL,
	created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS messages_session ON messages(session_id, id);
`)
	return err
}

func (s *Store) Close() error { return s.db.Close() }

func (s *Store) Dir() string { return s.dir }

func (s *Store) SessionDir(id string) string {
	return filepath.Join(s.dir, "sessions", id)
}

func (s *Store) NewSession(workspace string) (*Session, error) {
	id := fmt.Sprintf("%d", time.Now().UnixNano())
	now := time.Now()
	_, err := s.db.Exec(
		`INSERT INTO sessions(id, title, workspace, created_at, updated_at) VALUES(?, ?, ?, ?, ?)`,
		id, "New chat", workspace, now.UnixMilli(), now.UnixMilli(),
	)
	if err != nil {
		return nil, err
	}
	if err := os.MkdirAll(s.SessionDir(id), 0o700); err != nil {
		return nil, err
	}
	return &Session{ID: id, Title: "New chat", Workspace: workspace, CreatedAt: now, UpdatedAt: now}, nil
}

func (s *Store) ListSessions(limit int) ([]Session, error) {
	if limit <= 0 {
		limit = 50
	}
	rows, err := s.db.Query(
		`SELECT id, title, workspace, created_at, updated_at FROM sessions ORDER BY updated_at DESC LIMIT ?`, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Session
	for rows.Next() {
		var item Session
		var created, updated int64
		if err := rows.Scan(&item.ID, &item.Title, &item.Workspace, &created, &updated); err != nil {
			return nil, err
		}
		item.CreatedAt = time.UnixMilli(created)
		item.UpdatedAt = time.UnixMilli(updated)
		out = append(out, item)
	}
	return out, rows.Err()
}

func (s *Store) Session(id string) (*Session, error) {
	row := s.db.QueryRow(`SELECT id, title, workspace, created_at, updated_at FROM sessions WHERE id = ?`, id)
	var item Session
	var created, updated int64
	if err := row.Scan(&item.ID, &item.Title, &item.Workspace, &created, &updated); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, os.ErrNotExist
		}
		return nil, err
	}
	item.CreatedAt = time.UnixMilli(created)
	item.UpdatedAt = time.UnixMilli(updated)
	return &item, nil
}

func (s *Store) RenameSession(id, title string) error {
	_, err := s.db.Exec(`UPDATE sessions SET title = ?, updated_at = ? WHERE id = ?`, title, time.Now().UnixMilli(), id)
	return err
}

func (s *Store) Touch(id string) error {
	_, err := s.db.Exec(`UPDATE sessions SET updated_at = ? WHERE id = ?`, time.Now().UnixMilli(), id)
	return err
}

func (s *Store) AppendMessage(sessionID, role, text string) error {
	_, err := s.db.Exec(
		`INSERT INTO messages(session_id, role, text, created_at) VALUES(?, ?, ?, ?)`,
		sessionID, role, text, time.Now().UnixMilli(),
	)
	return err
}

func (s *Store) ClearMessages(sessionID string) error {
	_, err := s.db.Exec(`DELETE FROM messages WHERE session_id = ?`, sessionID)
	return err
}

func (s *Store) Messages(sessionID string) ([]Message, error) {
	rows, err := s.db.Query(
		`SELECT id, session_id, role, text, created_at FROM messages WHERE session_id = ? ORDER BY id`, sessionID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Message
	for rows.Next() {
		var item Message
		var created int64
		if err := rows.Scan(&item.ID, &item.SessionID, &item.Role, &item.Text, &created); err != nil {
			return nil, err
		}
		item.CreatedAt = time.UnixMilli(created)
		out = append(out, item)
	}
	return out, rows.Err()
}
