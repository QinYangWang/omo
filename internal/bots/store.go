// Package bots keeps the team: the roster, the groups, and one append-only
// message ledger per conversation.
//
// The ledger is the only place a message is stored. Everything else (the UI,
// group members, memory, channels) reads from it, so a message can never
// diverge between readers. Roster and read cursors live in state.json because
// they are small, changed rarely, and must be easy to inspect.
package bots

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

const (
	stateFile    = "state.json"
	ledgerDir    = "ledger"
	stateVersion = 1
)

// Roles and permission presets follow DS Bot's vocabulary.
const (
	RoleMain   = "main"
	RoleMember = "member"

	PermissionReadOnly  = "read-only"
	PermissionWorkspace = "workspace"
	PermissionFull      = "full"
)

// Ledger record kinds. Only `message` is delivered to a Bot; the rest is
// history other readers can show.
const (
	KindMessage = "message"
	KindNotice  = "notice"
)

// Bot is one long-lived teammate. Its conversation is a durable agent session
// keyed by ID; the roster entry itself is configuration.
type Bot struct {
	ID         string `json:"id"`
	Name       string `json:"name"`
	Role       string `json:"role"`
	Model      string `json:"model,omitempty"`
	Thinking   string `json:"thinking,omitempty"`
	Folder     string `json:"folder,omitempty"`
	Permission string `json:"permission,omitempty"`
	Private    bool   `json:"private,omitempty"`
	// ConversationID is the durable conversation this Bot owns; the runtime
	// creates it on first open and reports it back.
	ConversationID string `json:"conversationId,omitempty"`
	CreatedAt      int64  `json:"createdAt"`
}

// Group is a room. Members answer in their own Bot conversation; the group has
// its own conversation for the transcript and shared memory.
type Group struct {
	ID         string   `json:"id"`
	Name       string   `json:"name"`
	AdminID    string   `json:"adminId,omitempty"`
	Members    []string `json:"members"`
	Folder     string   `json:"folder,omitempty"`
	Permission string   `json:"permission,omitempty"`
	Notice     string   `json:"notice,omitempty"`
	CreatedAt  int64    `json:"createdAt"`
}

// Record is one ledger line. Seq ascends within a scope and is never reused.
type Record struct {
	Seq         int64  `json:"seq"`
	ID          string `json:"id"`
	At          int64  `json:"at"`
	Kind        string `json:"kind"`
	From        string `json:"from,omitempty"`
	To          string `json:"to,omitempty"`
	Text        string `json:"text,omitempty"`
	RequestID   string `json:"requestId,omitempty"`
	Fingerprint string `json:"fingerprint,omitempty"`
}

// InboxItem is one unread exchange: every unread message from the same sender
// in the same scope merged into one item, as DS Bot does, so an inbox can never
// grow into a backlog of near-identical messages.
type InboxItem struct {
	Scope    string  `json:"scope"`
	From     string  `json:"from"`
	FromName string  `json:"fromName"`
	Text     string  `json:"text"`
	Records  []int64 `json:"records"`
	LastSeq  int64   `json:"lastSeq"`
	LastAt   int64   `json:"lastAt"`
}

type state struct {
	Version int              `json:"version"`
	Bots    []Bot            `json:"bots"`
	Groups  []Group          `json:"groups"`
	Cursors map[string]int64 `json:"cursors"`
}

type ledger struct {
	scope     string
	path      string
	file      *os.File
	records   []Record
	byRequest map[string]int
	lastSeq   int64
}

// Store is the team state. One Store per data directory.
type Store struct {
	mu        sync.Mutex
	dir       string
	ledgerDir string
	st        state
	ledgers   map[string]*ledger
}

// Open loads state.json and prepares the ledger directory. Missing files are a
// new team, not an error.
func Open(dir string) (*Store, error) {
	s := &Store{dir: dir, ledgerDir: filepath.Join(dir, ledgerDir), ledgers: map[string]*ledger{}}
	if err := os.MkdirAll(s.ledgerDir, 0o700); err != nil {
		return nil, err
	}
	s.st = state{Version: stateVersion, Cursors: map[string]int64{}}
	data, err := os.ReadFile(filepath.Join(dir, stateFile))
	switch {
	case err == nil:
		if err := json.Unmarshal(data, &s.st); err != nil {
			return nil, fmt.Errorf("read %s: %w", stateFile, err)
		}
		if s.st.Version == 0 {
			s.st.Version = stateVersion
		}
		if s.st.Cursors == nil {
			s.st.Cursors = map[string]int64{}
		}
	case errors.Is(err, os.ErrNotExist):
	default:
		return nil, err
	}
	return s, nil
}

// Close closes the ledger files and saves state.json.
func (s *Store) Close() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, l := range s.ledgers {
		if l.file != nil {
			_ = l.file.Close()
			l.file = nil
		}
	}
	return s.save()
}

func (s *Store) save() error {
	data, err := json.MarshalIndent(s.st, "", "  ")
	if err != nil {
		return err
	}
	tmp := filepath.Join(s.dir, stateFile+".tmp")
	if err := os.WriteFile(tmp, data, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, filepath.Join(s.dir, stateFile))
}

// PairScope is the ledger identity of the two Bots' exchange.
func PairScope(a, b string) string {
	if a > b {
		a, b = b, a
	}
	return "pair-" + a + "-" + b
}

// GroupScope is the ledger identity of a group.
func GroupScope(groupID string) string { return "group-" + groupID }

func cursorKey(scope, botID string) string { return scope + "|" + botID }

func newID(prefix string) string {
	buf := make([]byte, 8)
	if _, err := rand.Read(buf); err != nil {
		return prefix + fmt.Sprintf("%d", time.Now().UnixNano())
	}
	return prefix + hex.EncodeToString(buf)
}

// Bots returns a copy of the roster in creation order.
func (s *Store) Bots() []Bot {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]Bot(nil), s.st.Bots...)
}

// Bot looks a Bot up by ID.
func (s *Store) Bot(id string) (Bot, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, bot := range s.st.Bots {
		if bot.ID == id {
			return bot, true
		}
	}
	return Bot{}, false
}

// BotByName looks a Bot up case-insensitively, which is how mentions resolve.
func (s *Store) BotByName(name string) (Bot, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.botByName(name)
}

func (s *Store) botByName(name string) (Bot, bool) {
	for _, bot := range s.st.Bots {
		if strings.EqualFold(bot.Name, strings.TrimSpace(name)) {
			return bot, true
		}
	}
	return Bot{}, false
}

var reservedNames = map[string]bool{"all": true, "everyone": true, "所有人": true, "全体": true}

func validateBot(bot Bot, bots []Bot) error {
	name := strings.TrimSpace(bot.Name)
	if name == "" {
		return errors.New("bot name is required")
	}
	if len([]rune(name)) > 60 {
		return errors.New("bot name is longer than 60 characters")
	}
	if reservedNames[strings.ToLower(name)] {
		return fmt.Errorf("%q is reserved for mentions", name)
	}
	for _, other := range bots {
		if other.ID != bot.ID && strings.EqualFold(other.Name, name) {
			return fmt.Errorf("a bot named %q already exists", name)
		}
	}
	switch bot.Permission {
	case "", PermissionReadOnly, PermissionWorkspace, PermissionFull:
	default:
		return fmt.Errorf("unknown permission preset %q", bot.Permission)
	}
	return nil
}

// AddBot adds a teammate. The first one becomes the main Bot unless a role is
// given, so a new team has a chief without a special case.
func (s *Store) AddBot(bot Bot) (Bot, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := validateBot(bot, s.st.Bots); err != nil {
		return Bot{}, err
	}
	if bot.ID == "" {
		bot.ID = newID("b")
	}
	if bot.Role == "" {
		if len(s.st.Bots) == 0 {
			bot.Role = RoleMain
		} else {
			bot.Role = RoleMember
		}
	}
	if bot.Permission == "" {
		bot.Permission = PermissionWorkspace
	}
	bot.Name = strings.TrimSpace(bot.Name)
	bot.CreatedAt = time.Now().UnixMilli()
	s.st.Bots = append(s.st.Bots, bot)
	if err := s.save(); err != nil {
		return Bot{}, err
	}
	return bot, nil
}

// SetBotConversation records the durable conversation the runtime created
// for a Bot so it is reopened instead of duplicated.
func (s *Store) SetBotConversation(id, conversationID string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	for i := range s.st.Bots {
		if s.st.Bots[i].ID == id {
			if s.st.Bots[i].ConversationID == conversationID {
				return nil
			}
			s.st.Bots[i].ConversationID = conversationID
			return s.save()
		}
	}
	return fmt.Errorf("bot %s does not exist", id)
}

// UpdateBot edits a existing teammate. Settings only exist for the person the
// Bot works for, so role changes stay out of this call.
func (s *Store) UpdateBot(bot Bot) (Bot, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for i, existing := range s.st.Bots {
		if existing.ID != bot.ID {
			continue
		}
		bot.CreatedAt = existing.CreatedAt
		bot.Role = existing.Role
		if bot.Permission == "" {
			bot.Permission = existing.Permission
		}
		if err := validateBot(bot, s.st.Bots); err != nil {
			return Bot{}, err
		}
		bot.Name = strings.TrimSpace(bot.Name)
		s.st.Bots[i] = bot
		if err := s.save(); err != nil {
			return Bot{}, err
		}
		return bot, nil
	}
	return Bot{}, fmt.Errorf("bot %s does not exist", bot.ID)
}

// DeleteBot removes a teammate from the roster and from every group. Its
// ledger history stays, so past work remains readable.
func (s *Store) DeleteBot(id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	index := -1
	for i, bot := range s.st.Bots {
		if bot.ID == id {
			index = i
			break
		}
	}
	if index < 0 {
		return fmt.Errorf("bot %s does not exist", id)
	}
	s.st.Bots = append(s.st.Bots[:index], s.st.Bots[index+1:]...)
	for i := range s.st.Groups {
		group := &s.st.Groups[i]
		if group.AdminID == id {
			group.AdminID = ""
		}
		kept := group.Members[:0]
		for _, member := range group.Members {
			if member != id {
				kept = append(kept, member)
			}
		}
		group.Members = kept
	}
	for key := range s.st.Cursors {
		if strings.HasSuffix(key, "|"+id) {
			delete(s.st.Cursors, key)
		}
	}
	return s.save()
}

// Groups returns a copy of the groups in creation order.
func (s *Store) Groups() []Group {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]Group, len(s.st.Groups))
	copy(out, s.st.Groups)
	return out
}

// Group looks a group up by ID.
func (s *Store) Group(id string) (Group, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.group(id)
}

func (s *Store) group(id string) (Group, bool) {
	for _, group := range s.st.Groups {
		if group.ID == id {
			return group, true
		}
	}
	return Group{}, false
}

// AddGroup creates a room; its members must already exist.
func (s *Store) AddGroup(group Group) (Group, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.addGroup(group)
}

func (s *Store) addGroup(group Group) (Group, error) {
	if strings.TrimSpace(group.Name) == "" {
		return Group{}, errors.New("group name is required")
	}
	for _, other := range s.st.Groups {
		if other.ID != group.ID && strings.EqualFold(other.Name, group.Name) {
			return Group{}, fmt.Errorf("a group named %q already exists", group.Name)
		}
	}
	if len(group.Members) > 12 {
		return Group{}, errors.New("a group has at most 12 bots")
	}
	seen := map[string]bool{}
	for _, member := range group.Members {
		if seen[member] {
			return Group{}, fmt.Errorf("bot %s is a member twice", member)
		}
		seen[member] = true
		if _, ok := s.bot(member); !ok {
			return Group{}, fmt.Errorf("bot %s does not exist", member)
		}
	}
	if group.AdminID != "" && !seen[group.AdminID] {
		return Group{}, errors.New("the admin must be a member")
	}
	if group.ID == "" {
		group.ID = newID("g")
	}
	group.CreatedAt = time.Now().UnixMilli()
	s.st.Groups = append(s.st.Groups, group)
	if err := s.save(); err != nil {
		return Group{}, err
	}
	return group, nil
}

func (s *Store) bot(id string) (Bot, bool) {
	for _, bot := range s.st.Bots {
		if bot.ID == id {
			return bot, true
		}
	}
	return Bot{}, false
}

// SendMessage appends one exchange. With a request id it is idempotent: the
// same sender, scope, id and text returns the original record instead of
// appending again, while reusing the id for different text is an error.
func (s *Store) SendMessage(from, to, text, requestID string) (Record, bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	from, to = strings.TrimSpace(from), strings.TrimSpace(to)
	text = strings.TrimSpace(text)
	if from == "" || to == "" {
		return Record{}, false, errors.New("from and to are required")
	}
	if from == to {
		return Record{}, false, errors.New("a bot cannot message itself")
	}
	if text == "" {
		return Record{}, false, errors.New("message text is empty")
	}
	if _, ok := s.bot(from); !ok {
		return Record{}, false, fmt.Errorf("bot %s does not exist", from)
	}
	if _, ok := s.bot(to); !ok {
		return Record{}, false, fmt.Errorf("bot %s does not exist", to)
	}
	scope := PairScope(from, to)
	l := s.ensureLedger(scope)
	fingerprint := fingerprintOf(from, to, text)
	if requestID != "" {
		if rec, ok := l.byRequestKey(from + "\x00" + requestID); ok {
			if rec.Fingerprint != fingerprint {
				return Record{}, false, fmt.Errorf("request id %q was already used with different content", requestID)
			}
			return rec, true, nil
		}
	}
	rec, err := s.appendLocked(scope, Record{Kind: KindMessage, From: from, To: to, Text: text, RequestID: requestID, Fingerprint: fingerprint})
	return rec, false, err
}

// AppendNotice records a non-delivered event (a start, a stop, a completion)
// in a scope's history.
func (s *Store) AppendNotice(scope, kind, from, text string) (Record, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if strings.TrimSpace(scope) == "" {
		return Record{}, errors.New("scope is required")
	}
	return s.appendLocked(scope, Record{Kind: kind, From: from, Text: text})
}

func fingerprintOf(from, to, text string) string {
	sum := sha256.Sum256([]byte(from + "\x00" + to + "\x00" + text))
	return hex.EncodeToString(sum[:])
}

func (s *Store) appendLocked(scope string, rec Record) (Record, error) {
	l := s.ensureLedger(scope)
	if l.file == nil {
		file, err := os.OpenFile(l.path, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600)
		if err != nil {
			return Record{}, err
		}
		l.file = file
	}
	rec.Seq = l.lastSeq + 1
	if rec.At == 0 {
		rec.At = time.Now().UnixMilli()
	}
	if rec.ID == "" {
		rec.ID = newID("m")
	}
	if rec.Kind == "" {
		rec.Kind = KindMessage
	}
	data, err := json.Marshal(rec)
	if err != nil {
		return Record{}, err
	}
	if _, err := l.file.Write(append(data, '\n')); err != nil {
		return Record{}, err
	}
	if err := l.file.Sync(); err != nil {
		return Record{}, err
	}
	l.adopt(rec)
	return rec, nil
}

// Messages returns the whole ledger of one scope, oldest first.
func (s *Store) Messages(scope string) ([]Record, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	l := s.ensureLedger(scope)
	return append([]Record(nil), l.records...), nil
}

// Scopes lists ledger scopes that exist on disk.
func (s *Store) Scopes() ([]string, error) {
	entries, err := os.ReadDir(s.ledgerDir)
	if err != nil {
		return nil, err
	}
	var out []string
	for _, entry := range entries {
		name := entry.Name()
		if entry.IsDir() || !strings.HasSuffix(name, ".jsonl") {
			continue
		}
		out = append(out, strings.TrimSuffix(name, ".jsonl"))
	}
	sort.Strings(out)
	return out, nil
}

// Inbox lists what botID has not read yet, merged per sender and scope. Group
// rounds are not delivered through the inbox; they are a turn, not a mailbox.
func (s *Store) Inbox(botID string) ([]InboxItem, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	scopes, err := s.Scopes()
	if err != nil {
		return nil, err
	}
	var items []InboxItem
	for _, scope := range scopes {
		if !strings.HasPrefix(scope, "pair-") || !pairHas(scope, botID) {
			continue
		}
		l := s.ensureLedger(scope)
		cursor := s.st.Cursors[cursorKey(scope, botID)]
		bySender := map[string]*InboxItem{}
		for _, rec := range l.records {
			if rec.Seq <= cursor || rec.Kind != KindMessage || rec.To != botID {
				continue
			}
			item := bySender[rec.From]
			if item == nil {
				item = &InboxItem{Scope: scope, From: rec.From, FromName: s.nameOf(rec.From)}
				bySender[rec.From] = item
			}
			if item.Text != "" {
				item.Text += "\n\n"
			}
			item.Text += rec.Text
			item.Records = append(item.Records, rec.Seq)
			item.LastSeq = rec.Seq
			item.LastAt = rec.At
		}
		for _, item := range bySender {
			items = append(items, *item)
		}
	}
	sort.Slice(items, func(i, j int) bool {
		if items[i].LastAt != items[j].LastAt {
			return items[i].LastAt < items[j].LastAt
		}
		return items[i].LastSeq < items[j].LastSeq
	})
	return items, nil
}

func (s *Store) nameOf(botID string) string {
	if bot, ok := s.bot(botID); ok {
		return bot.Name
	}
	return botID
}

func pairHas(scope, botID string) bool {
	if !strings.HasPrefix(scope, "pair-") {
		return false
	}
	parts := strings.Split(strings.TrimPrefix(scope, "pair-"), "-")
	for _, part := range parts {
		if part == botID {
			return true
		}
	}
	return false
}

// MarkRead moves botID's cursor in a scope to seq (it never moves backwards).
func (s *Store) MarkRead(botID, scope string, seq int64) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	key := cursorKey(scope, botID)
	if seq <= s.st.Cursors[key] {
		return nil
	}
	s.st.Cursors[key] = seq
	return s.save()
}

func (s *Store) ensureLedger(scope string) *ledger {
	if l, ok := s.ledgers[scope]; ok {
		return l
	}
	l := &ledger{scope: scope, path: filepath.Join(s.ledgerDir, scope+".jsonl"), byRequest: map[string]int{}}
	if data, err := os.ReadFile(l.path); err == nil {
		for _, line := range strings.Split(string(data), "\n") {
			line = strings.TrimSpace(line)
			if line == "" {
				continue
			}
			var rec Record
			if err := json.Unmarshal([]byte(line), &rec); err != nil {
				continue // a torn last line from a crash is skipped, not fatal
			}
			l.adopt(rec)
		}
	}
	s.ledgers[scope] = l
	return l
}

func (l *ledger) adopt(rec Record) {
	l.records = append(l.records, rec)
	if rec.Seq > l.lastSeq {
		l.lastSeq = rec.Seq
	}
	if rec.RequestID != "" {
		l.byRequest[rec.From+"\x00"+rec.RequestID] = len(l.records) - 1
	}
}

func (l *ledger) byRequestKey(key string) (Record, bool) {
	index, ok := l.byRequest[key]
	if !ok {
		return Record{}, false
	}
	return l.records[index], true
}
