// Package documents owns the editor buffers of the open files.
//
// The buffer is the authority for unsaved content; the disk is the saved state
// (docs/architecture.md §4.1). A save writes the buffer only when the disk still
// holds what was read, so an agent or another process that edited the file is
// never silently overwritten.
package documents

import (
	"bytes"
	"errors"

	"github.com/QinYangWang/omo/internal/workspace"
	"github.com/egoist/mygo/ui/editor"
)

// Doc is one open file: its buffer plus the stamp of the version on disk.
type Doc struct {
	Rel   string
	Buf   *editor.Buffer
	Saved workspace.FileStamp
}

// Store holds the open documents of the current workspace.
type Store struct {
	ws   *workspace.Service
	docs map[string]*Doc
}

// New returns an empty store for a workspace.
func New(ws *workspace.Service) *Store {
	return &Store{ws: ws, docs: make(map[string]*Doc)}
}

// Open returns the document of rel, reading it the first time. already reports
// whether it was open before.
func (s *Store) Open(rel string) (doc *Doc, already bool, err error) {
	if d, ok := s.docs[rel]; ok {
		return d, true, nil
	}
	data, st, err := s.ws.Read(rel)
	if err != nil {
		return nil, false, err
	}
	buf := editor.NewBuffer(string(data))
	buf.SetLanguage(editor.LanguageFor(rel))
	d := &Doc{Rel: rel, Buf: buf, Saved: st}
	s.docs[rel] = d
	return d, false, nil
}

// Get returns an open document.
func (s *Store) Get(rel string) (*Doc, bool) {
	d, ok := s.docs[rel]
	return d, ok
}

// OpenRels lists the open documents' paths.
func (s *Store) OpenRels() []string {
	out := make([]string, 0, len(s.docs))
	for rel := range s.docs {
		out = append(out, rel)
	}
	return out
}

// Dirty reports whether a document has unsaved changes.
func (s *Store) Dirty(rel string) bool {
	d, ok := s.docs[rel]
	return ok && d.Buf.Modified()
}

// Save writes a document's buffer to disk.
//
// It returns workspace.ErrConflict when the file changed since it was read; the
// caller must then ask the user rather than choose for them.
func (s *Store) Save(rel string) error {
	d, ok := s.docs[rel]
	if !ok {
		return errors.New("documents: not open")
	}
	var buf bytes.Buffer
	if _, err := d.Buf.WriteTo(&buf); err != nil {
		return err
	}
	st, err := s.ws.Write(rel, buf.Bytes(), d.Saved)
	if err != nil {
		return err
	}
	d.Buf.MarkSaved()
	d.Saved = st
	return nil
}

// ForceSave writes the buffer over whatever is on disk, without the conflict
// check. Call it only after the user chose to overwrite.
func (s *Store) ForceSave(rel string) error {
	d, ok := s.docs[rel]
	if !ok {
		return errors.New("documents: not open")
	}
	var buf bytes.Buffer
	if _, err := d.Buf.WriteTo(&buf); err != nil {
		return err
	}
	st, err := s.ws.Write(rel, buf.Bytes(), workspace.FileStamp{})
	if err != nil {
		return err
	}
	d.Buf.MarkSaved()
	d.Saved = st
	return nil
}

// Reload discards the buffer's content and reads the file again. changed
// reports whether the text actually differed.
func (s *Store) Reload(rel string) (changed bool, err error) {
	d, ok := s.docs[rel]
	if !ok {
		return false, errors.New("documents: not open")
	}
	data, st, err := s.ws.Read(rel)
	if err != nil {
		return false, err
	}
	if string(data) == d.Buf.String() {
		d.Saved = st
		return false, nil
	}
	d.Buf.Reset(string(data))
	d.Saved = st
	return true, nil
}

// CheckDisk reports whether the file on disk still matches what was read, and
// the current stamp when it does not. A missing file counts as changed.
func (s *Store) CheckDisk(rel string) (same bool, err error) {
	d, ok := s.docs[rel]
	if !ok {
		return true, nil
	}
	return s.ws.Verify(rel, d.Saved)
}

// Adopt makes the given stamp the saved state without touching the buffer, for
// a caller that wrote the file itself (a diff review applying its result).
func (s *Store) Adopt(rel string) {
	d, ok := s.docs[rel]
	if !ok {
		return
	}
	if st, err := s.ws.Stat(rel); err == nil {
		d.Buf.MarkSaved()
		d.Saved = st
	}
}

// Close forgets a document.
func (s *Store) Close(rel string) {
	delete(s.docs, rel)
}

// CloseAll forgets every document, as when the workspace changes.
func (s *Store) CloseAll() {
	s.docs = make(map[string]*Doc)
}
