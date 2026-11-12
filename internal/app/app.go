// Package app holds the desktop app's state and the wiring between the
// window, the SQLite chat store and the Pi Durable runtime.
package app

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/egoist/mygo"

	"github.com/QinYangWang/omo/internal/chat"
	"github.com/QinYangWang/omo/internal/config"
	"github.com/QinYangWang/omo/internal/host"
	"github.com/QinYangWang/omo/internal/plugins"
	moejsruntime "github.com/QinYangWang/omo/internal/runtime/moejs"
)

type Message struct {
	Role string
	Text string
}

type snapshotMessage struct {
	ID   int64  `json:"id"`
	Role string `json:"role"`
	Text string `json:"text"`
}

type snapshot struct {
	Ready    bool              `json:"ready"`
	Status   string            `json:"status"`
	Messages []snapshotMessage `json:"messages"`
	Partial  string            `json:"partial"`
	Tool     *struct {
		Name   string `json:"name"`
		Status string `json:"status"`
	} `json:"tool"`
	Failure string `json:"failure"`
}

type App struct {
	Win    *mygo.Window
	Config *config.Config
	Store  *chat.Store
	Engine *moejsruntime.Engine
	WS     *host.Workspace

	Sessions []chat.Session
	Session  *chat.Session

	Messages []Message
	Partial  string
	Status   string
	Failure  string
	Input    string
	Ready    bool

	ShowSettings  bool
	ShowPlugins   bool
	Catalog       moejsruntime.Catalog
	CatalogErr    string
	DraftBaseURL  string
	DraftModel    string
	DraftKey      string
	DraftTemp     string
	DraftProvider string
	ModelQuery    string
	DraftWS       string
	draftLoaded   string
	CustomModels  []string
	Fetching      bool
	FetchErr      string
	FetchNotice   string
	fetchSeq      int
	fetchedBase   string
	Plugins       *plugins.Manager
	PluginErr     string
	PluginNotice  string

	persisted int
	mu        sync.Mutex
}

func New(cfg *config.Config, store *chat.Store, engine *moejsruntime.Engine) *App {
	a := &App{Config: cfg, Store: store, Engine: engine, Status: "idle"}
	manager, err := plugins.Open(cfg.Dir())
	if err != nil {
		a.PluginErr = err.Error()
	}
	a.Plugins = manager
	a.Sessions, _ = store.ListSessions(50)
	a.refreshCatalog()
	return a
}

func (a *App) refreshCatalog() {
	customModels := a.CustomModels
	if a.fetchedBase != "" && !sameBaseURL(a.fetchedBase, a.Config.Settings.BaseURL) {
		customModels = nil
	}
	customModel := ""
	if a.Config.Settings.Provider == customProviderID {
		customModel = a.Config.Settings.Model
	}
	catalog, err := a.Engine.ListCatalog(a.Config.Settings.BaseURL, customModel, customModels)
	if err != nil {
		a.CatalogErr = err.Error()
		a.Logf("load pi-ai catalog: %v", err)
		return
	}
	a.Catalog = catalog
	a.CatalogErr = ""
}

func sameBaseURL(a, b string) bool {
	return strings.EqualFold(strings.TrimRight(strings.TrimSpace(a), "/"), strings.TrimRight(strings.TrimSpace(b), "/"))
}

func (a *App) customModelsFor(baseURL, selected string) []string {
	if a.fetchedBase == "" || !sameBaseURL(a.fetchedBase, baseURL) {
		return nil
	}
	out := make([]string, 0, len(a.CustomModels)+1)
	seen := map[string]bool{}
	for _, id := range append(append([]string(nil), a.CustomModels...), selected) {
		id = strings.TrimSpace(id)
		if id == "" || seen[id] {
			continue
		}
		seen[id] = true
		out = append(out, id)
	}
	return out
}

// FetchModels asks the configured OpenAI-compatible endpoint for its
// /models list. It runs off the UI goroutine and only updates the draft
// catalog; the user still has to press Save to persist the selection.
func (a *App) FetchModels() {
	if !a.IsCustomProvider() {
		return
	}
	baseURL := strings.TrimRight(strings.TrimSpace(a.DraftBaseURL), "/")
	apiKey := strings.TrimSpace(a.DraftKey)
	model := strings.TrimSpace(a.DraftModel)
	if baseURL == "" {
		a.FetchErr = "Enter a Base URL before fetching models."
		a.FetchNotice = ""
		return
	}
	a.fetchSeq++
	seq := a.fetchSeq
	a.Fetching = true
	a.FetchErr = ""
	a.FetchNotice = ""
	go func() {
		ids, err := fetchOpenAIModels(context.Background(), baseURL, apiKey)
		var catalog moejsruntime.Catalog
		if err == nil {
			catalog, err = a.Engine.ListCatalog(baseURL, model, ids)
		}
		a.update(func() {
			if seq != a.fetchSeq {
				return
			}
			a.Fetching = false
			if err != nil {
				a.FetchErr = err.Error()
				return
			}
			a.CustomModels = append([]string(nil), ids...)
			a.fetchedBase = baseURL
			a.Catalog = catalog
			a.CatalogErr = ""
			a.DraftBaseURL = baseURL
			if model == "" && len(ids) > 0 {
				a.DraftModel = ids[0]
			}
			a.FetchNotice = fmt.Sprintf("Fetched %d models from %s/models.", len(ids), baseURL)
		})
	}()
}

func (a *App) Logf(format string, args ...any) {
	log.Printf(format, args...)
}

// Start listens for runtime events. It must be called once, before the
// window exists; snapshots that arrive early are held until Attach.
func (a *App) Start() {
	go func() {
		for ev := range a.Engine.Events() {
			switch ev.Kind {
			case "state", "sent", "aborted":
				a.applySnapshot(ev.Message)
			case "error":
				a.setFailure(ev.Message)
			}
		}
	}()
}

func (a *App) Attach(win *mygo.Window) { a.Win = win }

func (a *App) update(fn func()) {
	if a.Win == nil {
		fn()
		return
	}
	a.Win.Update(fn)
}

// Update runs fn on the window's UI goroutine.
func (a *App) Update(fn func()) { a.update(fn) }

func (a *App) setFailure(text string) {
	a.update(func() {
		a.Failure = text
		a.Status = "error"
	})
}

func (a *App) applySnapshot(text string) {
	var snap snapshot
	if err := json.Unmarshal([]byte(text), &snap); err != nil {
		a.Logf("bad snapshot: %v", err)
		return
	}
	a.update(func() {
		a.Ready = snap.Ready
		a.Status = snap.Status
		a.Partial = snap.Partial
		a.Failure = snap.Failure
		messages := make([]Message, 0, len(snap.Messages))
		for _, item := range snap.Messages {
			messages = append(messages, Message{Role: item.Role, Text: item.Text})
		}
		a.Messages = messages
		a.persistNew()
	})
}

// persistNew writes messages the SQLite store has not seen yet.
func (a *App) persistNew() {
	if a.Session == nil {
		return
	}
	if a.persisted > len(a.Messages) {
		a.persisted = 0
	}
	for _, msg := range a.Messages[a.persisted:] {
		if err := a.Store.AppendMessage(a.Session.ID, msg.Role, msg.Text); err != nil {
			a.Logf("append message: %v", err)
		}
	}
	a.persisted = len(a.Messages)
	_ = a.Store.Touch(a.Session.ID)
	if a.Session.Title == "New chat" {
		for _, msg := range a.Messages {
			if msg.Role == "user" {
				title := strings.TrimSpace(msg.Text)
				if len(title) > 48 {
					title = title[:48] + "…"
				}
				if title != "" {
					a.Session.Title = title
					_ = a.Store.RenameSession(a.Session.ID, title)
					a.Sessions, _ = a.Store.ListSessions(50)
				}
				break
			}
		}
	}
}

func (a *App) SetWorkspace(dir string) error {
	ws, err := host.Open(dir)
	if err != nil {
		return err
	}
	a.WS = ws
	a.Config.Settings.Workspace = ws.Root()
	_ = a.Config.Save()
	a.Engine.SetWorkspace(ws)
	return nil
}

// ChooseWorkspace opens the native folder picker.
func (a *App) ChooseWorkspace() {
	go func() {
		paths, err := mygo.Dialog.Open(mygo.OpenDialogOptions{
			Parent:    a.Win,
			Title:     "Choose a workspace",
			Directory: true,
		})
		if err != nil || len(paths) == 0 {
			return
		}
		path := paths[0]
		a.update(func() {
			if err := a.SetWorkspace(path); err != nil {
				a.Failure = err.Error()
				a.Status = "error"
				return
			}
			a.Failure = ""
			if a.Session != nil {
				a.startNewChat()
			}
		})
	}()
}

func (a *App) StartNewChat() {
	a.update(func() { a.startNewChat() })
}

func (a *App) startNewChat() {
	if a.WS == nil {
		a.ChooseWorkspace()
		return
	}
	session, err := a.Store.NewSession(a.WS.Root())
	if err != nil {
		a.Failure = err.Error()
		return
	}
	a.openSession(session)
}

func (a *App) OpenSession(id string) {
	session, err := a.Store.Session(id)
	if err != nil {
		a.Failure = err.Error()
		return
	}
	a.update(func() {
		if a.WS == nil || !strings.EqualFold(a.WS.Root(), session.Workspace) {
			if err := a.SetWorkspace(session.Workspace); err != nil {
				a.Failure = fmt.Sprintf("workspace %s is unavailable: %v", session.Workspace, err)
				return
			}
		}
		a.openSession(session)
	})
}

func (a *App) openSession(session *chat.Session) {
	a.Session = session
	a.Messages = nil
	a.Partial = ""
	a.Failure = ""
	a.Status = "idle"
	a.Ready = false
	a.persisted = 0
	// The durable transcript is the source of truth; rebuild the sidebar
	// mirror from it instead of appending duplicates.
	if err := a.Store.ClearMessages(session.ID); err != nil {
		a.Logf("clear mirrored messages: %v", err)
	}
	if err := a.SetWorkspace(session.Workspace); err != nil {
		a.Failure = fmt.Sprintf("workspace %s is unavailable: %v", session.Workspace, err)
		a.Status = "error"
		return
	}
	if err := a.Engine.OpenSession(moejsruntime.SessionConfig{
		DBPath:       filepath.Join(a.Store.SessionDir(session.ID), "durable.db"),
		BaseURL:      strings.TrimRight(a.Config.Settings.BaseURL, "/"),
		Provider:     a.Config.Settings.Provider,
		Model:        a.Config.Settings.Model,
		CustomModels: a.customModelsFor(a.Config.Settings.BaseURL, a.Config.Settings.Model),
		Workspace:    a.WS.Root(),
		Credentials:  a.Config.Credentials,
		MaxTokens:    a.Config.Settings.MaxTokens,
		Temperature:  a.Config.Settings.Temperature,
	}); err != nil {
		a.Failure = err.Error()
		a.Status = "error"
	}
}

func (a *App) Send(text string) {
	text = strings.TrimSpace(text)
	if text == "" {
		return
	}
	if a.Session == nil {
		a.startNewChat()
		if a.Session == nil {
			return
		}
	}
	if !a.Config.Ready() {
		a.ShowSettings = true
		a.Failure = "Choose a provider, model and credential in Settings first."
		return
	}
	a.Input = ""
	a.Failure = ""
	a.Status = "running"
	if err := a.Engine.Send(text); err != nil {
		a.Failure = err.Error()
		a.Status = "error"
	}
}

func (a *App) Stop() {
	if err := a.Engine.Abort(); err != nil {
		a.Logf("abort: %v", err)
	}
}

func (a *App) OpenSettings() {
	a.ShowSettings = true
	if !a.Fetching {
		a.FetchErr = ""
		a.FetchNotice = ""
	}
	a.DraftBaseURL = a.Config.Settings.BaseURL
	a.DraftModel = a.Config.Settings.Model
	a.DraftProvider = a.Config.Settings.Provider
	a.draftLoaded = a.DraftProvider
	a.DraftTemp = fmt.Sprintf("%.2f", a.Config.Settings.Temperature)
	a.ModelQuery = ""
	a.DraftWS = a.Config.Settings.Workspace
	if a.Provider(a.DraftProvider) != nil {
		a.ChooseProvider(a.DraftProvider)
	} else {
		if provider := a.defaultProvider(); provider != nil {
			a.ChooseProvider(provider.ID)
		}
	}
}

func (a *App) SaveSettings() {
	var temp float64
	fmt.Sscanf(a.DraftTemp, "%f", &temp)
	providerID := strings.TrimSpace(a.DraftProvider)
	model := strings.TrimSpace(a.DraftModel)
	provider := a.Provider(providerID)
	if provider == nil {
		a.Failure = "Choose a provider from the pi-ai catalog."
		return
	}
	if model == "" {
		a.Failure = "Choose a model from the pi-ai catalog."
		return
	}
	if providerID == customProviderID {
		baseURL := strings.TrimSpace(a.DraftBaseURL)
		if baseURL == "" {
			a.Failure = "An OpenAI-compatible provider needs a base URL."
			return
		}
		a.Config.Settings.BaseURL = baseURL
	} else if !a.providerHasModel(providerID, model) {
		a.Failure = fmt.Sprintf("Model %s is not in the %s catalog.", model, provider.Name)
		return
	}
	a.Config.Settings.Provider = providerID
	a.Config.Settings.Model = model
	a.Config.Settings.Temperature = temp
	a.Config.SetCredential(providerID, strings.TrimSpace(a.DraftKey))
	if a.fetchedBase != "" && !sameBaseURL(a.fetchedBase, a.Config.Settings.BaseURL) {
		a.fetchedBase = ""
		a.CustomModels = nil
		a.FetchNotice = ""
		a.FetchErr = ""
	}
	if err := a.Config.Save(); err != nil {
		a.Failure = err.Error()
		return
	}
	a.ShowSettings = false
	a.Failure = ""
	a.refreshCatalog()
	if a.Session != nil {
		a.openSession(a.Session)
	}
}

const customProviderID = "openai-compatible"

func (a *App) Providers() []moejsruntime.CatalogProvider {
	return a.Catalog.Providers
}

func (a *App) Provider(id string) *moejsruntime.CatalogProvider {
	for i := range a.Catalog.Providers {
		if a.Catalog.Providers[i].ID == id {
			return &a.Catalog.Providers[i]
		}
	}
	return nil
}

func (a *App) defaultProvider() *moejsruntime.CatalogProvider {
	if provider := a.Provider(a.Config.Settings.Provider); provider != nil {
		return provider
	}
	if len(a.Catalog.Providers) > 0 {
		return &a.Catalog.Providers[0]
	}
	return nil
}

func (a *App) ChooseProvider(id string) {
	provider := a.Provider(id)
	if provider == nil {
		return
	}
	a.DraftProvider = id
	a.draftLoaded = id
	a.DraftKey = a.Config.Credential(id)
	a.DraftBaseURL = provider.BaseURL
	a.ModelQuery = ""
	if id == customProviderID {
		if !a.providerHasModel(id, a.DraftModel) {
			a.DraftModel = ""
			if len(provider.Models) > 0 {
				a.DraftModel = provider.Models[0].ID
			}
		}
		return
	}
	if !a.providerHasModel(id, a.DraftModel) {
		a.DraftModel = ""
		if len(provider.Models) > 0 {
			a.DraftModel = provider.Models[0].ID
		}
	}
}

// SyncDraftProvider updates the model and credential drafts after the
// provider select writes a new provider id.
func (a *App) SyncDraftProvider() {
	if a.DraftProvider != a.draftLoaded {
		a.ChooseProvider(a.DraftProvider)
	}
}

func (a *App) ChooseModel(id string) {
	a.DraftModel = id
}

func (a *App) IsCustomProvider() bool {
	return a.DraftProvider == customProviderID
}

func (a *App) ProviderModels() []moejsruntime.CatalogModel {
	provider := a.Provider(a.DraftProvider)
	if provider == nil {
		return nil
	}
	query := strings.ToLower(strings.TrimSpace(a.ModelQuery))
	if query == "" {
		return provider.Models
	}
	out := make([]moejsruntime.CatalogModel, 0, len(provider.Models))
	for _, model := range provider.Models {
		if strings.Contains(strings.ToLower(model.ID), query) || strings.Contains(strings.ToLower(model.Name), query) {
			out = append(out, model)
		}
	}
	return out
}

func (a *App) providerHasModel(providerID, modelID string) bool {
	provider := a.Provider(providerID)
	if provider == nil {
		return false
	}
	for _, model := range provider.Models {
		if model.ID == modelID {
			return true
		}
	}
	return false
}

func (a *App) CatalogSummary() string {
	if a.CatalogErr != "" {
		return "pi-ai catalog unavailable: " + a.CatalogErr
	}
	models := 0
	for _, provider := range a.Catalog.Providers {
		models += len(provider.Models)
	}
	return fmt.Sprintf("%d providers, %d chat models from pi-ai", len(a.Catalog.Providers), models)
}

func (a *App) SelectedProviderName() string {
	if provider := a.Provider(a.DraftProvider); provider != nil {
		return provider.Name
	}
	return a.DraftProvider
}

func (a *App) SelectedProviderBaseURL() string {
	if a.IsCustomProvider() {
		return a.DraftBaseURL
	}
	if provider := a.Provider(a.DraftProvider); provider != nil {
		return provider.BaseURL
	}
	return ""
}

func (a *App) SessionDir(id string) string { return a.Store.SessionDir(id) }

func (a *App) DataDir() string { return a.Store.Dir() }

func (a *App) DockName() string { return filepath.Base(a.WS.Root()) }

func (a *App) WorkspaceLabel() string {
	if a.WS == nil {
		return "No workspace selected"
	}
	return a.WS.Root()
}

func (a *App) ElapsedSince(created time.Time) string {
	d := time.Since(created)
	switch {
	case d < time.Minute:
		return "just now"
	case d < time.Hour:
		return fmt.Sprintf("%dm ago", int(d.Minutes()))
	case d < 24*time.Hour:
		return fmt.Sprintf("%dh ago", int(d.Hours()))
	default:
		return fmt.Sprintf("%dd ago", int(d.Hours()/24))
	}
}

func (a *App) ApiKeyNotice() string {
	return "Provider credentials are stored in " + filepath.Join(a.Config.Dir(), "credentials.json") +
		". Unix uses file mode 0600; Windows relies on the user profile's ACL. A packaged build should move it to the system keychain."
}

func (a *App) KeyPresent() bool { return a.Config.Credential(a.DraftProvider) != "" }

func (a *App) HasWorkspace() bool { return a.WS != nil }

func (a *App) WorkspaceExists() bool {
	if a.WS == nil {
		return false
	}
	_, err := os.Stat(a.WS.Root())
	return err == nil
}
