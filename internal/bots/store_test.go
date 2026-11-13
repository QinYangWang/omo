package bots

import (
	"os"
	"path/filepath"
	"testing"
)

func openTeam(t *testing.T, dir string) *Store {
	t.Helper()
	store, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	return store
}

func seed(t *testing.T, store *Store) (chief, dev Bot) {
	t.Helper()
	chief, err := store.AddBot(Bot{Name: "Chief", Role: RoleMain})
	if err != nil {
		t.Fatal(err)
	}
	dev, err = store.AddBot(Bot{Name: "Dev", Model: "deepseek-chat"})
	if err != nil {
		t.Fatal(err)
	}
	return chief, dev
}

func TestRosterAndGroupsPersist(t *testing.T) {
	dir := t.TempDir()
	store := openTeam(t, dir)
	chief, dev := seed(t, store)
	if chief.Role != RoleMain || dev.Role != RoleMember {
		t.Fatalf("roles: chief=%q dev=%q", chief.Role, dev.Role)
	}
	group, err := store.AddGroup(Group{Name: "Build", AdminID: chief.ID, Members: []string{chief.ID, dev.ID}, Notice: "ship it"})
	if err != nil {
		t.Fatal(err)
	}
	if err := store.Close(); err != nil {
		t.Fatal(err)
	}

	reopened := openTeam(t, dir)
	defer reopened.Close()
	if len(reopened.Bots()) != 2 {
		t.Fatalf("roster did not persist: %+v", reopened.Bots())
	}
	got, ok := reopened.BotByName("dev")
	if !ok || got.Model != "deepseek-chat" || got.ID != dev.ID {
		t.Fatalf("bot lookup by name: %+v %v", got, ok)
	}
	room, ok := reopened.Group(group.ID)
	if !ok || room.Notice != "ship it" || len(room.Members) != 2 {
		t.Fatalf("group did not persist: %+v %v", room, ok)
	}
}

func TestSendIsIdempotentPerRequestID(t *testing.T) {
	store := openTeam(t, t.TempDir())
	defer store.Close()
	chief, dev := seed(t, store)

	first, duplicate, err := store.SendMessage(chief.ID, dev.ID, "fix the build", "work-1")
	if err != nil || duplicate {
		t.Fatalf("first send: %v duplicate=%v", err, duplicate)
	}
	again, duplicate, err := store.SendMessage(chief.ID, dev.ID, "fix the build", "work-1")
	if err != nil || !duplicate {
		t.Fatalf("second send should be a duplicate: %v duplicate=%v", err, duplicate)
	}
	if again.ID != first.ID || again.Seq != first.Seq {
		t.Fatalf("duplicate should return the original record: %+v vs %+v", again, first)
	}
	if _, _, err := store.SendMessage(chief.ID, dev.ID, "something else", "work-1"); err == nil {
		t.Fatal("reusing a request id with new content must fail")
	}
	records, err := store.Messages(PairScope(chief.ID, dev.ID))
	if err != nil {
		t.Fatal(err)
	}
	if len(records) != 1 {
		t.Fatalf("ledger should hold one message, got %d", len(records))
	}
}

func TestInboxMergesPerSenderAndPersistsCursor(t *testing.T) {
	dir := t.TempDir()
	store := openTeam(t, dir)
	chief, dev := seed(t, store)

	if _, _, err := store.SendMessage(dev.ID, chief.ID, "part one", ""); err != nil {
		t.Fatal(err)
	}
	if _, _, err := store.SendMessage(dev.ID, chief.ID, "part two", ""); err != nil {
		t.Fatal(err)
	}
	items, err := store.Inbox(chief.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(items) != 1 || items[0].Text != "part one\n\npart two" || len(items[0].Records) != 2 {
		t.Fatalf("unread from one sender must merge: %+v", items)
	}
	if items[0].FromName != "Dev" {
		t.Fatalf("sender name: %q", items[0].FromName)
	}
	// The sender's own inbox stays empty: messages are addressed, not broadcast.
	if own, _ := store.Inbox(dev.ID); len(own) != 0 {
		t.Fatalf("sender should not see its own message: %+v", own)
	}

	scope := PairScope(chief.ID, dev.ID)
	if err := store.MarkRead(chief.ID, scope, items[0].LastSeq); err != nil {
		t.Fatal(err)
	}
	if items, _ := store.Inbox(chief.ID); len(items) != 0 {
		t.Fatalf("read messages should leave the inbox: %+v", items)
	}
	if err := store.Close(); err != nil {
		t.Fatal(err)
	}

	reopened := openTeam(t, dir)
	defer reopened.Close()
	if items, _ := reopened.Inbox(chief.ID); len(items) != 0 {
		t.Fatalf("cursor did not persist: %+v", items)
	}
	if _, _, err := reopened.SendMessage(dev.ID, chief.ID, "part three", ""); err != nil {
		t.Fatal(err)
	}
	if items, _ := reopened.Inbox(chief.ID); len(items) != 1 || items[0].Text != "part three" {
		t.Fatalf("only the new message should be unread: %+v", items)
	}
}

func TestLedgerReplaysInOrder(t *testing.T) {
	dir := t.TempDir()
	store := openTeam(t, dir)
	chief, dev := seed(t, store)
	scope := PairScope(chief.ID, dev.ID)
	for i, text := range []string{"one", "two", "three"} {
		if _, _, err := store.SendMessage(chief.ID, dev.ID, text, ""); err != nil {
			t.Fatalf("send %d: %v", i, err)
		}
	}
	if err := store.Close(); err != nil {
		t.Fatal(err)
	}

	reopened := openTeam(t, dir)
	defer reopened.Close()
	records, err := reopened.Messages(scope)
	if err != nil {
		t.Fatal(err)
	}
	if len(records) != 3 {
		t.Fatalf("want 3 records, got %d", len(records))
	}
	for i, rec := range records {
		if rec.Seq != int64(i+1) || rec.Text != []string{"one", "two", "three"}[i] {
			t.Fatalf("record %d out of order: %+v", i, rec)
		}
	}
	next, _, err := reopened.SendMessage(chief.ID, dev.ID, "four", "")
	if err != nil {
		t.Fatal(err)
	}
	if next.Seq != 4 {
		t.Fatalf("sequence should continue after reopen, got %d", next.Seq)
	}
}

func TestDeleteBotCleansGroupsAndKeepsLedger(t *testing.T) {
	dir := t.TempDir()
	store := openTeam(t, dir)
	defer store.Close()
	chief, dev := seed(t, store)
	group, err := store.AddGroup(Group{Name: "Build", AdminID: chief.ID, Members: []string{chief.ID, dev.ID}})
	if err != nil {
		t.Fatal(err)
	}
	scope := PairScope(chief.ID, dev.ID)
	if _, _, err := store.SendMessage(chief.ID, dev.ID, "hello", ""); err != nil {
		t.Fatal(err)
	}
	if err := store.DeleteBot(dev.ID); err != nil {
		t.Fatal(err)
	}
	if _, ok := store.Bot(dev.ID); ok {
		t.Fatal("deleted bot is still in the roster")
	}
	reloaded, ok := store.Group(group.ID)
	if !ok || len(reloaded.Members) != 1 || reloaded.Members[0] != chief.ID {
		t.Fatalf("deleted bot is still a member: %+v", reloaded)
	}
	records, err := store.Messages(scope)
	if err != nil || len(records) != 1 {
		t.Fatalf("history should survive deletion: %v %+v", err, records)
	}
	if _, err := os.Stat(filepath.Join(dir, "ledger", scope+".jsonl")); err != nil {
		t.Fatalf("ledger file missing: %v", err)
	}
}
