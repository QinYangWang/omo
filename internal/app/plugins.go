package app

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"os"
	"path/filepath"

	"github.com/egoist/mygo"

	"github.com/QinYangWang/omo/internal/plugins"
)

func (a *App) OpenPlugins() {
	a.ShowPlugins = true
	a.ShowSettings = false
	a.PluginNotice = ""
}

func (a *App) ClosePlugins() {
	a.ShowPlugins = false
}

func (a *App) PluginList() []plugins.Installed {
	if a.Plugins == nil {
		return nil
	}
	return a.Plugins.List()
}

func (a *App) ActiveUIPlugin() *plugins.Installed {
	if a.Plugins == nil {
		return nil
	}
	return a.Plugins.ActiveUI()
}

func (a *App) ActiveUIName() string {
	if plugin := a.ActiveUIPlugin(); plugin != nil {
		return plugin.Name
	}
	return "Built-in UI"
}

func (a *App) ActiveUIPluginAllows(permission string) bool {
	plugin := a.ActiveUIPlugin()
	if plugin == nil {
		return false
	}
	for _, declared := range plugin.Permissions {
		if declared == permission {
			return true
		}
	}
	return false
}

// PluginUIFile returns a plugin's UI document; the shell parses it.
func (a *App) PluginUIFile(plugin *plugins.Installed) ([]byte, error) {
	if a.Plugins == nil || plugin == nil || plugin.UI == nil {
		return nil, fmt.Errorf("plugin has no UI")
	}
	return a.Plugins.ReadUIFile(plugin.ID, plugin.UI.Main)
}

// InstallPluginFolder opens the native folder picker and installs the selected
// plugin directory. New plugins start disabled.
func (a *App) InstallPluginFolder() {
	if a.Plugins == nil {
		a.PluginErr = "plugin manager is unavailable"
		return
	}
	go func() {
		paths, err := mygo.Dialog.Open(mygo.OpenDialogOptions{
			Parent:    a.Win,
			Title:     "Choose a plugin folder",
			Directory: true,
		})
		if err != nil || len(paths) == 0 {
			return
		}
		manifest, err := a.Plugins.InstallDir(paths[0])
		a.update(func() {
			if err != nil {
				a.PluginErr = err.Error()
				a.PluginNotice = ""
				return
			}
			a.PluginErr = ""
			a.PluginNotice = fmt.Sprintf("Installed %s %s. Enable it to use it.", manifest.Name, manifest.Version)
		})
	}()
}

// InstallPluginZip opens the native file picker and installs a shared plugin
// archive.
func (a *App) InstallPluginZip() {
	if a.Plugins == nil {
		a.PluginErr = "plugin manager is unavailable"
		return
	}
	go func() {
		paths, err := mygo.Dialog.Open(mygo.OpenDialogOptions{
			Parent:  a.Win,
			Title:   "Choose a plugin archive",
			Filters: []mygo.FileFilter{{Name: "omo plugin", Extensions: []string{"zip"}}},
		})
		if err != nil || len(paths) == 0 {
			return
		}
		data, err := os.ReadFile(paths[0])
		if err != nil {
			a.update(func() { a.PluginErr = err.Error() })
			return
		}
		manifest, err := a.Plugins.InstallZip(data)
		a.update(func() {
			if err != nil {
				a.PluginErr = err.Error()
				a.PluginNotice = ""
				return
			}
			a.PluginErr = ""
			a.PluginNotice = fmt.Sprintf("Installed %s %s. Enable it to use it.", manifest.Name, manifest.Version)
		})
	}()
}

// ExportPlugin packs an installed plugin into a ZIP so it can be shared.
func (a *App) ExportPlugin(id string) {
	if a.Plugins == nil {
		a.PluginErr = "plugin manager is unavailable"
		return
	}
	plugin := a.Plugins.Get(id)
	if plugin == nil {
		a.PluginErr = fmt.Sprintf("plugin %q is not installed", id)
		return
	}
	data, err := a.Plugins.Archive(id)
	if err != nil {
		a.PluginErr = err.Error()
		return
	}
	name := fmt.Sprintf("%s-%s.zip", plugin.ID, plugin.Version)
	go func() {
		path, err := mygo.Dialog.Save(mygo.SaveDialogOptions{
			Parent:      a.Win,
			Title:       "Export plugin",
			DefaultPath: name,
			Filters:     []mygo.FileFilter{{Name: "omo plugin", Extensions: []string{"zip"}}},
		})
		if err != nil || path == "" {
			return
		}
		if err := os.WriteFile(path, data, 0o600); err != nil {
			a.update(func() { a.PluginErr = err.Error() })
			return
		}
		sum := sha256.Sum256(data)
		a.update(func() {
			a.PluginErr = ""
			a.PluginNotice = fmt.Sprintf("Exported %s. SHA-256: %s", filepath.Base(path), hex.EncodeToString(sum[:]))
		})
	}()
}

func (a *App) SetPluginEnabled(id string, enabled bool) {
	if a.Plugins == nil {
		return
	}
	if err := a.Plugins.SetEnabled(id, enabled); err != nil {
		a.PluginErr = err.Error()
		return
	}
	a.PluginErr = ""
	if enabled {
		a.PluginNotice = "Plugin enabled."
	} else {
		a.PluginNotice = "Plugin disabled."
	}
}

func (a *App) ActivateUIPlugin(id string) {
	if a.Plugins == nil {
		return
	}
	if err := a.Plugins.SetActiveUI(id); err != nil {
		a.PluginErr = err.Error()
		return
	}
	a.PluginErr = ""
	a.PluginNotice = "Active UI changed."
	a.ShowPlugins = false
	a.ShowSettings = false
}

func (a *App) UseBuiltinUI() {
	if a.Plugins == nil {
		return
	}
	if err := a.Plugins.SetActiveUI(""); err != nil {
		a.PluginErr = err.Error()
		return
	}
	a.PluginNotice = "Using the built-in UI."
}

func (a *App) UninstallPlugin(id string) {
	if a.Plugins == nil {
		return
	}
	if err := a.Plugins.Uninstall(id); err != nil {
		a.PluginErr = err.Error()
		return
	}
	a.PluginErr = ""
	a.PluginNotice = "Plugin removed."
}

func (a *App) PluginRoot() string {
	if a.Plugins == nil {
		return ""
	}
	return a.Plugins.Root()
}
