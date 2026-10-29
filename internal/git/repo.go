// Package git shells out to the system git binary.
//
// It is deliberately small: P1 needs a branch name, the list of changed files,
// and one file's text at HEAD, which is the baseline a diff review shows. A Go
// git implementation would add megabytes of dependency for that (see
// docs/dependencies.md §6). Every command uses an argument array, never a shell
// string (docs/security.md §3).
package git

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os/exec"
	"path"
	"strings"
	"time"
)

// ErrNotRepo means the directory is not inside a git work tree.
var ErrNotRepo = errors.New("git: not a repository")

const commandTimeout = 10 * time.Second

// Repo is a work tree that contains the workspace directory.
type Repo struct {
	root   string // work tree root, absolute
	prefix string // workspace directory relative to root, "" or "sub/dir"
}

// Detect finds the work tree containing dir.
func Detect(ctx context.Context, dir string) (*Repo, error) {
	out, err := run(ctx, dir, "rev-parse", "--show-toplevel")
	if err != nil {
		// git exits non-zero outside a work tree; that is an answer, not a bug.
		return nil, ErrNotRepo
	}
	root := strings.TrimSpace(string(out))
	if root == "" {
		return nil, ErrNotRepo
	}
	r := &Repo{root: root}
	// --show-prefix is relative to the directory git runs in, so ask from the
	// workspace, not from the root we just found.
	if prefix, err := run(ctx, dir, "rev-parse", "--show-prefix"); err == nil {
		r.prefix = strings.TrimSuffix(strings.TrimSpace(string(prefix)), "/")
	}
	return r, nil
}

// Root is the work tree root.
func (r *Repo) Root() string { return r.root }

// Prefix is the workspace directory relative to the root, without a trailing
// slash ("" when the workspace is the root).
func (r *Repo) Prefix() string { return r.prefix }

// Branch returns the current branch name, or a short commit hash when HEAD is
// detached. It is cheap enough to call on demand, not every frame.
func (r *Repo) Branch(ctx context.Context) (string, error) {
	out, err := r.run(ctx, "branch", "--show-current")
	if err != nil {
		return "", err
	}
	if name := strings.TrimSpace(string(out)); name != "" {
		return name, nil
	}
	out, err = r.run(ctx, "rev-parse", "--short", "HEAD")
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(string(out)), nil
}

// Change is one path whose content differs from HEAD.
type Change struct {
	Path   string // relative to the workspace
	Status string // "M", "A", "D", "R", "C", "?", "U", …: porcelain's XY, trimmed
}

// Status lists the changed paths under the workspace, untracked files included.
func (r *Repo) Status(ctx context.Context) ([]Change, error) {
	// -z separates entries with NUL, which keeps file names with spaces and
	// quotes intact without parsing C-style escapes.
	out, err := r.run(ctx, "status", "--porcelain=v1", "-z", "--untracked-files=all")
	if err != nil {
		return nil, err
	}
	var changes []Change
	fields := bytes.Split(out, []byte{0})
	for i := 0; i < len(fields); i++ {
		entry := fields[i]
		if len(entry) < 4 {
			continue
		}
		xy := string(entry[:2])
		p := string(entry[3:])
		if strings.HasPrefix(xy, "R") || strings.HasPrefix(xy, "C") {
			i++ // the next field is the original path
		}
		rel, ok := r.toWorkspace(p)
		if !ok {
			continue
		}
		changes = append(changes, Change{Path: rel, Status: oneLetter(xy)})
	}
	return changes, nil
}

// HeadText returns a file's text at HEAD, and whether it is there at all: a new
// file has no HEAD version, which a diff review shows as an empty old side.
func (r *Repo) HeadText(ctx context.Context, rel string) (text string, inHead bool, err error) {
	spec := "HEAD:" + r.toRepo(rel)
	out, err := r.run(ctx, "show", spec)
	if err != nil {
		// A missing path in HEAD, or a repository without commits, is not a
		// failure of the review: there is simply nothing to compare against.
		if _, verr := r.run(ctx, "rev-parse", "--verify", "HEAD"); verr != nil {
			return "", false, nil
		}
		return "", false, nil
	}
	return string(out), true, nil
}

// toRepo turns a workspace-relative path into a repository-relative one.
func (r *Repo) toRepo(rel string) string {
	rel = strings.TrimPrefix(strings.ReplaceAll(rel, "\\", "/"), "/")
	if r.prefix == "" {
		return rel
	}
	return path.Join(r.prefix, rel)
}

// toWorkspace turns a repository-relative path into a workspace-relative one,
// reporting false for paths outside the workspace.
func (r *Repo) toWorkspace(p string) (string, bool) {
	p = strings.ReplaceAll(p, "\\", "/")
	if r.prefix == "" {
		return path.Clean(p), true
	}
	if p == r.prefix {
		return "", false
	}
	rest, ok := strings.CutPrefix(p, r.prefix+"/")
	if !ok {
		return "", false
	}
	return rest, true
}

// oneLetter turns porcelain's two status columns into the one letter the UI
// shows: the index status, else the work tree's, so " M" and "M " both read
// "M" and an untracked file reads "?".
func oneLetter(xy string) string {
	if len(xy) < 2 {
		return strings.TrimSpace(xy)
	}
	if xy[0] != ' ' && xy[0] != '?' {
		return xy[:1]
	}
	if xy[1] != ' ' && xy[1] != '?' {
		return xy[1:2]
	}
	return "?"
}

// run executes git in the work tree with a deadline and returns its stdout.
func (r *Repo) run(ctx context.Context, args ...string) ([]byte, error) {
	return run(ctx, r.root, args...)
}

// run executes git in dir with a deadline and returns its stdout.
func run(ctx context.Context, dir string, args ...string) ([]byte, error) {
	ctx, cancel := context.WithTimeout(ctx, commandTimeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, "git", args...)
	cmd.Dir = dir
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	cmd.WaitDelay = time.Second
	out, err := cmd.Output()
	if err != nil {
		msg := strings.TrimSpace(stderr.String())
		if msg == "" {
			msg = err.Error()
		}
		return nil, fmt.Errorf("git %s: %s", strings.Join(args, " "), msg)
	}
	return out, nil
}
