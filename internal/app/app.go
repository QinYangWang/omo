// Package app holds the desktop app's state and the wiring between the
// window, the SQLite chat store and the Pi Durable runtime.
package app

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/egoist/mygo"

	"github.com/QinYangWang/omo/internal/bots"
	"github.com/QinYangWang/omo/internal/config"
	"github.com/QinYangWang/omo/internal/host"
	"github.com/QinYangWang/omo/internal/plugins"
	moejsruntime "github.com/QinYangWang/omo/internal/runtime/moejs"
	"github.com/QinYangWang/omo/internal/telemetry"
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

type botSnapshot struct {
	BotID    string            `json:"botId"`
	Status   string            `json:"status"`
	Messages []snapshotMessage `json:"messages"`
	Partial  string            `json:"partial"`
	Tool     *struct {
		Name   string `json:"name"`
		Status string `json:"status"`
	} `json:"tool"`
	Failure string              `json:"failure"`
	Metrics *telemetry.AgentRun `json:"metrics"`
}

type teamEvent struct {
	Ready   bool   `json:"ready"`
	Failure string `json:"failure"`
}

type botSessionEvent struct {
	BotID          string `json:"botId"`
	ConversationID string `json:"conversationId"`
}

// SessionView is one row of the session rail. A Bot is the session: opening a
// Bot opens its durable conversation.
type SessionView struct {
	ID        string
	Title     string
	Workspace string
	Status    string
}

type App struct {
	Win       *mygo.Window
	Config    *config.Config
	Bots      *bots.Store
	Telemetry *telemetry.Store
	Engine    *moejsruntime.Engine
	WS        *host.Workspace

	Sessions        []SessionView
	Session         *SessionView
	ActiveBotID     string
	TeamReady       bool
	teamWorkspace   string
	teamFingerprint string

	Messages []Message
	Partial  string
	Status   string
	Failure  string
	Input    string
	Ready    bool

	// Agent activity of the open session, newest last: per-turn metrics,
	// per-agent cache totals, and the agent dependency graph.
	AgentRuns  []telemetry.AgentRun
	AgentCache []telemetry.AgentCache
	Agents     []telemetry.Agent
	LastRun    *telemetry.AgentRun

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

	mu           sync.Mutex
	botSnapshots map[string]botSnapshot
}

func New(cfg *config.Config, roster *bots.Store, stats *telemetry.Store, engine *moejsruntime.Engine) *App {
	a := &App{Config: cfg, Bots: roster, Telemetry: stats, Engine: engine, Status: "idle", botSnapshots: map[string]botSnapshot{}}
	manager, err := plugins.Open(cfg.Dir())
	if err != nil {
		a.PluginErr = err.Error()
	}
	a.Plugins = manager
	a.refreshSessions()
	a.refreshCatalog()
	return a
}

// refreshSessions rebuilds the rail from the roster; a Bot's name is its title.
func (a *App) refreshSessions() {
	list := a.Bots.Bots()
	views := make([]SessionView, 0, len(list))
	for _, bot := range list {
		views = append(views, SessionView{
			ID:        bot.ID,
			Title:     bot.Name,
			Workspace: a.Config.Settings.Workspace,
			Status:    a.botStatus(bot.ID),
		})
	}
	a.Sessions = views
	a.Session = nil
	for i := range views {
		if views[i].ID == a.ActiveBotID {
			selected := views[i]
			a.Session = &selected
		}
	}
	if a.Session == nil && len(views) > 0 {
		a.ActiveBotID = views[0].ID
		selected := views[0]
		a.Session = &selected
	}
}

func (a *App) botStatus(botID string) string {
	a.mu.Lock()
	defer a.mu.Unlock()
	if snap, ok := a.botSnapshots[botID]; ok {
		return snap.Status
	}
	return "idle"
}

// TeamID is the stable identity of the team in this workspace. It names the
// durable database and the telemetry session.
func (a *App) TeamID() string {
	root := ""
	if a.WS != nil {
		root = a.WS.Root()
	}
	sum := sha256.Sum256([]byte(strings.ToLower(root)))
	return "t" + hex.EncodeToString(sum[:6])
}

// ensureChief makes sure a team has a main Bot to talk to.
func (a *App) ensureChief() error {
	for _, bot := range a.Bots.Bots() {
		if bot.Role == bots.RoleMain {
			return nil
		}
	}
	_, err := a.Bots.AddBot(bots.Bot{Name: "Chief", Role: bots.RoleMain, Permission: bots.PermissionWorkspace})
	if err != nil {
		return err
	}
	a.refreshSessions()
	return nil
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
			case "bot", "sent", "aborted":
				a.applyBot(ev.Message)
			case "team":
				a.applyTeam(ev.Message)
			case "bot_session":
				a.applyBotSession(ev.Message)
			case "metric":
				a.applyAgentRun(ev.Message)
			case "agent":
				a.applyAgent(ev.Message)
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

func (a *App) SetWorkspace(dir string) error {
	ws, err := host.Open(dir)
	if err != nil {
		return err
	}
	a.WS = ws
	a.teamWorkspace = ""
	a.TeamReady = false
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
			a.startNewChat()
		})
	}()
}

func (a *App) StartNewChat() {
	a.update(func() { a.startNewChat() })
}

// startNewChat opens the main Bot; a team without one gets Chief.
func (a *App) startNewChat() {
	if a.WS == nil {
		a.ChooseWorkspace()
		return
	}
	if err := a.ensureChief(); err != nil {
		a.Failure = err.Error()
		return
	}
	for _, bot := range a.Bots.Bots() {
		if bot.Role == bots.RoleMain {
			a.openBot(bot.ID)
			return
		}
	}
}

// OpenSession opens a Bot by id. The name is kept for the existing UI actions.
func (a *App) OpenSession(id string) {
	a.update(func() { a.openBot(id) })
}

// teamSignature changes when the roster or a Bot's conversation changes; the
// runtime must be reopened to pick it up.
func (a *App) teamSignature() string {
	var b strings.Builder
	for _, bot := range a.Bots.Bots() {
		b.WriteString(bot.ID)
		b.WriteString("@")
		b.WriteString(bot.ConversationID)
		b.WriteString("|")
	}
	return b.String()
}

func (a *App) openBot(id string) {
	bot, ok := a.Bots.Bot(id)
	if !ok {
		a.Failure = "No such Bot: " + id
		return
	}
	a.ActiveBotID = id
	a.refreshSessions()
	a.Messages = nil
	a.Partial = ""
	a.Failure = ""
	a.Status = "idle"
	a.Ready = false
	a.Input = ""
	a.LastRun = nil
	if snap, ok := a.botSnapshot(id); ok {
		a.applyBotSnapshot(snap)
	}
	a.AgentRuns, a.AgentCache, a.Agents = a.loadAgentActivity(a.TeamID())
	if a.WS == nil || a.teamWorkspace != a.WS.Root() || a.teamFingerprint != a.teamSignature() {
		if err := a.openTeam(bot.ID); err != nil {
			a.Failure = err.Error()
			a.Status = "error"
		}
	}
}

func (a *App) botSnapshot(botID string) (botSnapshot, bool) {
	a.mu.Lock()
	defer a.mu.Unlock()
	snap, ok := a.botSnapshots[botID]
	return snap, ok
}

// openTeam opens (or reopens) the team database with every Bot conversation.
func (a *App) openTeam(activeID string) error {
	if a.WS == nil {
		return fmt.Errorf("no workspace is open")
	}
	list := a.Bots.Bots()
	if len(list) == 0 {
		return fmt.Errorf("the team has no Bots")
	}
	specs := make([]moejsruntime.TeamBot, 0, len(list))
	for _, bot := range list {
		specs = append(specs, moejsruntime.TeamBot{
			ID:             bot.ID,
			Name:           bot.Name,
			Model:          bot.Model,
			ConversationID: bot.ConversationID,
		})
	}
	teamID := a.TeamID()
	if err := a.Engine.OpenTeam(moejsruntime.TeamConfig{
		DBPath:       filepath.Join(a.Config.Dir(), "teams", teamID, "durable.db"),
		TeamID:       teamID,
		BaseURL:      strings.TrimRight(a.Config.Settings.BaseURL, "/"),
		Provider:     a.Config.Settings.Provider,
		Model:        a.Config.Settings.Model,
		CustomModels: a.customModelsFor(a.Config.Settings.BaseURL, a.Config.Settings.Model),
		Workspace:    a.WS.Root(),
		Credentials:  a.Config.Credentials,
		MaxTokens:    a.Config.Settings.MaxTokens,
		Temperature:  a.Config.Settings.Temperature,
		Skills:       a.loadSkills(a.WS.Root()),
		Bots:         specs,
	}); err != nil {
		return err
	}
	a.teamWorkspace = a.WS.Root()
	a.teamFingerprint = a.teamSignature()
	a.TeamReady = false
	a.ActiveBotID = activeID
	return nil
}

// applyBot updates one Bot's cached snapshot and the visible messages when it
// is the active Bot.
func (a *App) applyBot(text string) {
	var snap botSnapshot
	if err := json.Unmarshal([]byte(text), &snap); err != nil {
		a.Logf("bad bot snapshot: %v", err)
		return
	}
	if snap.BotID == "" {
		return
	}
	a.mu.Lock()
	a.botSnapshots[snap.BotID] = snap
	a.mu.Unlock()
	a.update(func() {
		if snap.BotID == a.ActiveBotID {
			a.applyBotSnapshot(snap)
		}
		a.refreshSessions()
	})
}

func (a *App) applyBotSnapshot(snap botSnapshot) {
	a.Ready = true
	a.Status = snap.Status
	a.Partial = snap.Partial
	a.Failure = snap.Failure
	messages := make([]Message, 0, len(snap.Messages))
	for _, item := range snap.Messages {
		messages = append(messages, Message{Role: item.Role, Text: item.Text})
	}
	a.Messages = messages
	if snap.Metrics != nil {
		a.LastRun = snap.Metrics
	}
}

func (a *App) applyTeam(text string) {
	var ev teamEvent
	if err := json.Unmarshal([]byte(text), &ev); err != nil {
		a.Logf("bad team event: %v", err)
		return
	}
	a.update(func() {
		a.TeamReady = ev.Ready
		if ev.Ready {
			a.Ready = true
			if a.Failure != "" {
				a.Failure = ""
				a.Status = "idle"
			}
			return
		}
		a.Failure = ev.Failure
		a.Status = "error"
	})
}

func (a *App) applyBotSession(text string) {
	var ev botSessionEvent
	if err := json.Unmarshal([]byte(text), &ev); err != nil {
		a.Logf("bad bot session event: %v", err)
		return
	}
	if ev.BotID == "" || ev.ConversationID == "" {
		return
	}
	if err := a.Bots.SetBotConversation(ev.BotID, ev.ConversationID); err != nil {
		a.Logf("store bot conversation: %v", err)
		return
	}
	a.update(func() {
		a.teamFingerprint = a.teamSignature()
		a.refreshSessions()
	})
}

func (a *App) Send(text string) {
	text = strings.TrimSpace(text)
	if text == "" {
		return
	}
	if a.WS == nil {
		a.ChooseWorkspace()
		return
	}
	if a.ActiveBotID == "" {
		a.startNewChat()
	}
	if a.ActiveBotID == "" {
		return
	}
	if !a.Config.Ready() {
		a.ShowSettings = true
		a.Failure = "Choose a provider, model and credential in Settings first."
		return
	}
	if a.teamWorkspace != a.WS.Root() || a.teamFingerprint != a.teamSignature() {
		if err := a.openTeam(a.ActiveBotID); err != nil {
			a.Failure = err.Error()
			a.Status = "error"
			return
		}
	}
	a.Input = ""
	a.Failure = ""
	a.Status = "running"
	if err := a.Engine.SendTo(a.ActiveBotID, text); err != nil {
		a.Failure = err.Error()
		a.Status = "error"
	}
}

func (a *App) Stop() {
	if a.ActiveBotID == "" {
		return
	}
	if err := a.Engine.AbortBot(a.ActiveBotID); err != nil {
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
	if a.ActiveBotID != "" && a.WS != nil {
		if err := a.openTeam(a.ActiveBotID); err != nil {
			a.Failure = err.Error()
		}
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

func (a *App) SessionDir(id string) string { return filepath.Join(a.Config.Dir(), "teams") }

func (a *App) DataDir() string { return a.Config.Dir() }

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
