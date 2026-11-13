package app

import (
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"

	"github.com/egoist/mygo"
)

// maxAttachmentBytes caps one attached file: the copy lands in the workspace,
// and a huge file would stall the turn that has to read it.
const maxAttachmentBytes = 32 << 20

// BotFolder is the folder a Bot's tools run in: its own when set, else the
// team workspace. Group folders and per-member group folders come with groups.
func (a *App) BotFolder(botID string) string {
	if a.Bots != nil {
		if bot, ok := a.Bots.Bot(botID); ok && strings.TrimSpace(bot.Folder) != "" {
			return bot.Folder
		}
	}
	if a.WS != nil {
		return a.WS.Root()
	}
	return ""
}

// ActiveFolder is the folder the open Bot works in.
func (a *App) ActiveFolder() string { return a.BotFolder(a.ActiveBotID) }

// guardedFolder refuses omo's own data folder and its parents: a Bot that can
// write there could change its permissions and the team's records.
func (a *App) guardedFolder(dir string) error {
	data, err := filepath.EvalSymlinks(a.Config.Dir())
	if err != nil {
		data = filepath.Clean(a.Config.Dir())
	}
	if withinDir(dir, data) || withinDir(data, dir) {
		return fmt.Errorf("%s is inside or above omo's data folder, which a Bot may not reach", dir)
	}
	return nil
}

// withinDir reports whether target is root or below it.
func withinDir(root, target string) bool {
	root = strings.TrimRight(filepath.Clean(root), `\/`)
	target = strings.TrimRight(filepath.Clean(target), `\/`)
	if strings.EqualFold(root, target) {
		return true
	}
	return strings.HasPrefix(strings.ToLower(target), strings.ToLower(root)+string(os.PathSeparator))
}

// ChooseBotFolder opens the folder picker for the open Bot. Choosing a folder
// is the approval: the user picked it, so it applies to that Bot's next turn.
func (a *App) ChooseBotFolder() {
	botID := a.ActiveBotID
	if botID == "" {
		return
	}
	current := a.BotFolder(botID)
	go func() {
		paths, err := mygo.Dialog.Open(mygo.OpenDialogOptions{
			Parent:      a.Win,
			Title:       "Choose the Bot's folder",
			Directory:   true,
			DefaultPath: current,
		})
		if err != nil || len(paths) == 0 {
			return
		}
		a.update(func() {
			if err := a.SetBotFolder(botID, paths[0]); err != nil {
				a.Failure = err.Error()
			}
		})
	}()
}

// SetBotFolder points a Bot at dir, or back at the team workspace when dir is
// empty. It does not move files: the next turn runs in the new folder.
func (a *App) SetBotFolder(botID, dir string) error {
	bot, ok := a.Bots.Bot(botID)
	if !ok {
		return fmt.Errorf("no such Bot: %s", botID)
	}
	bot.Folder = ""
	if strings.TrimSpace(dir) != "" {
		real, err := filepath.EvalSymlinks(dir)
		if err != nil {
			return fmt.Errorf("folder %s is unavailable: %w", dir, err)
		}
		info, err := os.Stat(real)
		if err != nil || !info.IsDir() {
			return fmt.Errorf("%s is not a directory", dir)
		}
		if err := a.guardedFolder(real); err != nil {
			return err
		}
		bot.Folder = real
	}
	if _, err := a.Bots.UpdateBot(bot); err != nil {
		return err
	}
	a.Failure = ""
	a.refreshSessions()
	return nil
}

// ResetBotFolder returns the open Bot to the team workspace.
func (a *App) ResetBotFolder() {
	a.update(func() {
		if err := a.SetBotFolder(a.ActiveBotID, ""); err != nil {
			a.Failure = err.Error()
		}
	})
}

// AttachFiles picks files from anywhere and copies them into the Bot's folder
// (its uploads folder), where the agent's tools can read them.
func (a *App) AttachFiles() {
	root := a.ActiveFolder()
	if root == "" {
		a.ChooseWorkspace()
		return
	}
	botID := a.ActiveBotID
	go func() {
		paths, err := mygo.Dialog.Open(mygo.OpenDialogOptions{
			Parent:   a.Win,
			Title:    "Attach files",
			Multiple: true,
		})
		if err != nil || len(paths) == 0 {
			return
		}
		copied := make([]Attachment, 0, len(paths))
		var firstErr error
		for _, src := range paths {
			attachment, err := copyAttachment(root, botID, src)
			if err != nil {
				if firstErr == nil {
					firstErr = err
				}
				continue
			}
			copied = append(copied, attachment)
		}
		a.update(func() {
			a.Attachments = append(a.Attachments, copied...)
			if firstErr != nil {
				a.Failure = firstErr.Error()
			}
		})
	}()
}

// DetachFile drops the attachment at index.
func (a *App) DetachFile(index int) {
	a.update(func() {
		if index < 0 || index >= len(a.Attachments) {
			return
		}
		a.Attachments = append(a.Attachments[:index], a.Attachments[index+1:]...)
	})
}

// copyAttachment stores src in <workspace>/.omo/uploads/<bot>/, adding a
// suffix rather than overwriting a file already there.
func copyAttachment(root, botID, src string) (Attachment, error) {
	info, err := os.Stat(src)
	if err != nil {
		return Attachment{}, err
	}
	if info.IsDir() {
		return Attachment{}, fmt.Errorf("%s is a folder", src)
	}
	if info.Size() > maxAttachmentBytes {
		return Attachment{}, fmt.Errorf("%s is larger than %d MB", filepath.Base(src), maxAttachmentBytes>>20)
	}
	dir := filepath.Join(root, ".omo", "uploads", botID)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return Attachment{}, err
	}
	name := filepath.Base(src)
	target := filepath.Join(dir, name)
	for i := 2; ; i++ {
		if _, err := os.Stat(target); errors.Is(err, os.ErrNotExist) {
			break
		}
		ext := filepath.Ext(name)
		target = filepath.Join(dir, fmt.Sprintf("%s-%d%s", strings.TrimSuffix(name, ext), i, ext))
	}
	in, err := os.Open(src)
	if err != nil {
		return Attachment{}, err
	}
	defer in.Close()
	out, err := os.Create(target)
	if err != nil {
		return Attachment{}, err
	}
	n, err := io.Copy(out, in)
	if closeErr := out.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		return Attachment{}, err
	}
	rel, err := filepath.Rel(root, target)
	if err != nil {
		return Attachment{}, err
	}
	return Attachment{Name: filepath.Base(target), Path: filepath.ToSlash(rel), Size: n}, nil
}

// attachmentNote appends what the agent needs to find the files it was given.
func attachmentNote(text string, attachments []Attachment) string {
	var b strings.Builder
	b.WriteString(text)
	b.WriteString("\n\nAttached files, in the workspace:\n")
	for _, attachment := range attachments {
		fmt.Fprintf(&b, "- %s (%d bytes)\n", attachment.Path, attachment.Size)
	}
	return b.String()
}
