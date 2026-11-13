package app

import (
	"errors"
	"fmt"
	"strings"

	"github.com/QinYangWang/omo/internal/config"
	moejsruntime "github.com/QinYangWang/omo/internal/runtime/moejs"
)

// customProvider returns the user-added endpoint with this id, or nil.
func (a *App) customProvider(id string) *config.CustomProvider {
	for i := range a.Config.Settings.CustomProviders {
		if a.Config.Settings.CustomProviders[i].ID == id {
			return &a.Config.Settings.CustomProviders[i]
		}
	}
	return nil
}

// setCustomProvider edits one custom endpoint in place.
func (a *App) setCustomProvider(id string, edit func(*config.CustomProvider)) bool {
	provider := a.customProvider(id)
	if provider == nil {
		return false
	}
	edit(provider)
	return true
}

// AddCustomProvider stores a new OpenAI-compatible endpoint under a unique id
// made from its display name, and selects it.
func (a *App) AddCustomProvider(name, baseURL, key string) error {
	name = strings.TrimSpace(name)
	baseURL = strings.TrimRight(strings.TrimSpace(baseURL), "/")
	if name == "" {
		return errors.New("give the provider a name")
	}
	if baseURL == "" {
		return errors.New("enter the provider's base URL")
	}
	id := a.uniqueProviderID(name)
	a.Config.Settings.CustomProviders = append(a.Config.Settings.CustomProviders, config.CustomProvider{
		ID: id, Name: name, BaseURL: baseURL,
	})
	a.Config.SetCredential(id, strings.TrimSpace(key))
	if err := a.Config.Save(); err != nil {
		return err
	}
	a.refreshCatalog()
	a.ChooseProvider(id)
	return nil
}

// uniqueProviderID makes a provider id from name that no provider uses yet.
func (a *App) uniqueProviderID(name string) string {
	base := strings.Builder{}
	for _, r := range strings.ToLower(name) {
		switch {
		case r >= 'a' && r <= 'z', r >= '0' && r <= '9':
			base.WriteRune(r)
		case r == ' ' || r == '-' || r == '_' || r == '.':
			if base.Len() > 0 && !strings.HasSuffix(base.String(), "-") {
				base.WriteByte('-')
			}
		}
	}
	slug := strings.Trim(base.String(), "-")
	if slug == "" {
		slug = "custom"
	}
	taken := func(id string) bool {
		for _, provider := range a.Providers() {
			if provider.ID == id {
				return true
			}
		}
		return a.customProvider(id) != nil
	}
	id := slug
	for i := 2; taken(id); i++ {
		id = fmt.Sprintf("%s-%d", slug, i)
	}
	return id
}

// RemoveCustomProvider forgets one user-added endpoint and its key.
func (a *App) RemoveCustomProvider(id string) {
	a.update(func() {
		list := a.Config.Settings.CustomProviders[:0]
		for _, provider := range a.Config.Settings.CustomProviders {
			if provider.ID != id {
				list = append(list, provider)
			}
		}
		a.Config.Settings.CustomProviders = list
		a.Config.SetCredential(id, "")
		for key := range a.Config.Settings.Thinking {
			if strings.HasPrefix(key, id+"/") {
				delete(a.Config.Settings.Thinking, key)
			}
		}
		if err := a.Config.Save(); err != nil {
			a.Failure = err.Error()
			return
		}
		a.refreshCatalog()
		if a.Config.Settings.Provider == id {
			if next := a.defaultProvider(); next != nil {
				a.Config.Settings.Provider = next.ID
				a.Config.Settings.Model = ""
				if len(next.Models) > 0 {
					a.Config.Settings.Model = next.Models[0].ID
				}
				_ = a.Config.Save()
			}
		}
	})
}

// thinkingKey names one model's thinking level.
func thinkingKey(providerID, modelID string) string {
	return providerID + "/" + modelID
}

// ThinkingLevelsFor lists what the model takes, weakest first.
func (a *App) ThinkingLevelsFor(providerID, modelID string) []string {
	provider := a.Provider(providerID)
	if provider == nil {
		return []string{"off"}
	}
	for _, model := range provider.Models {
		if model.ID == modelID {
			if len(model.Thinking) > 0 {
				return model.Thinking
			}
			if model.Reasoning {
				return ThinkingLevels
			}
			return []string{"off"}
		}
	}
	return []string{"off"}
}

// ModelThinking is the level chosen for a model: the stored one, or a sensible
// default that the model supports.
func (a *App) ModelThinking(providerID, modelID string) string {
	levels := a.ThinkingLevelsFor(providerID, modelID)
	chosen := a.Config.Settings.Thinking[thinkingKey(providerID, modelID)]
	for _, level := range levels {
		if level == chosen {
			return chosen
		}
	}
	for _, level := range levels {
		if level == "medium" {
			return level
		}
	}
	return levels[0]
}

// ActiveThinking is the level for the model in use, and its supported levels.
func (a *App) ActiveThinking() (string, []string) {
	providerID := a.Config.Settings.Provider
	modelID := a.Config.Settings.Model
	return a.ModelThinking(providerID, modelID), a.ThinkingLevelsFor(providerID, modelID)
}

// SetThinking stores the level for the model in use and reopens the team so
// the next turn runs with it.
func (a *App) SetThinking(level string) {
	a.update(func() {
		providerID := a.Config.Settings.Provider
		modelID := a.Config.Settings.Model
		valid := false
		for _, known := range a.ThinkingLevelsFor(providerID, modelID) {
			if level == known {
				valid = true
				break
			}
		}
		if !valid {
			return
		}
		if a.Config.Settings.Thinking == nil {
			a.Config.Settings.Thinking = map[string]string{}
		}
		a.Config.Settings.Thinking[thinkingKey(providerID, modelID)] = level
		if err := a.Config.Save(); err != nil {
			a.Failure = err.Error()
			return
		}
		if a.ActiveBotID != "" && a.WS != nil {
			if err := a.openTeam(a.ActiveBotID); err != nil {
				a.Failure = err.Error()
			}
		}
	})
}

// botThinking is the level for a Bot's turn: its own model when it has one.
func (a *App) botThinking(botModel string) string {
	providerID := a.Config.Settings.Provider
	modelID := botModel
	if modelID == "" {
		modelID = a.Config.Settings.Model
	}
	return a.ModelThinking(providerID, modelID)
}

// ThinkingLevels are the reasoning levels pi-durable understands, weakest
// first. A model's catalog entry narrows this list.
var ThinkingLevels = []string{"off", "minimal", "low", "medium", "high", "xhigh", "max"}

// appThinking keeps only a level pi-durable knows, or "" for the model default.
func appThinking(level string) string {
	level = strings.ToLower(strings.TrimSpace(level))
	for _, known := range ThinkingLevels {
		if level == known {
			return level
		}
	}
	return ""
}

// ThinkingIndex is the position of level in levels, or 0.
func ThinkingIndex(level string, levels []string) int {
	for i, known := range levels {
		if known == level {
			return i
		}
	}
	return 0
}

// ProviderHasKey reports whether a credential is stored for the provider.
func (a *App) ProviderHasKey(id string) bool {
	return a.Config.Credential(id) != ""
}

// ProviderKeyHint masks a stored key down to its last four characters.
func (a *App) ProviderKeyHint(id string) string {
	key := a.Config.Credential(id)
	if key == "" {
		return ""
	}
	if len(key) <= 8 {
		return "••••"
	}
	return "••••" + key[len(key)-4:]
}

// ConfiguredProviders are the providers with a stored key, plus the one in use.
func (a *App) ConfiguredProviders() []moejsruntime.CatalogProvider {
	providers := a.Providers()
	out := make([]moejsruntime.CatalogProvider, 0, len(providers))
	for _, provider := range providers {
		if a.Config.Credential(provider.ID) != "" || provider.ID == a.Config.Settings.Provider || a.customProvider(provider.ID) != nil {
			out = append(out, provider)
		}
	}
	return out
}

// RemoveProviderKey forgets a provider's credential; the model in use keeps
// its name but cannot be called until a key is stored again.
func (a *App) RemoveProviderKey(id string) {
	a.update(func() {
		a.Config.SetCredential(id, "")
		if err := a.Config.Save(); err != nil {
			a.Failure = err.Error()
			return
		}
		if id == a.DraftProvider {
			a.DraftKey = ""
		}
	})
}

// IsCustomProviderID reports whether id is one of the user's endpoints.
func (a *App) IsCustomProviderID(id string) bool {
	return a.customProvider(id) != nil
}

// ActiveThinkingLevel is the level for the model in use.
func (a *App) ActiveThinkingLevel() string {
	level, _ := a.ActiveThinking()
	return level
}

// ActiveThinkingLevels are the levels the model in use supports.
func (a *App) ActiveThinkingLevels() []string {
	_, levels := a.ActiveThinking()
	return levels
}
