package agent

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"slices"
	"sort"
	"strings"
	"sync"
)

const maxCatalogBytes = 1 << 20

// Catalog is a JSON-file-backed set of agent definitions.
type Catalog struct {
	mu   sync.RWMutex
	path string
	defs map[string]Definition
}

func NewCatalog(path string) *Catalog {
	return &Catalog{path: path, defs: make(map[string]Definition)}
}

// Load replaces the catalog only after the complete file validates. A missing file is empty.
func (c *Catalog) Load() error {
	f, err := os.Open(c.path)
	if errors.Is(err, os.ErrNotExist) {
		c.mu.Lock()
		c.defs = make(map[string]Definition)
		c.mu.Unlock()
		return nil
	}
	if err != nil {
		return fmt.Errorf("agent catalog: %w", err)
	}
	defer f.Close()

	data, err := io.ReadAll(io.LimitReader(f, maxCatalogBytes+1))
	if err != nil {
		return fmt.Errorf("agent catalog: %w", err)
	}
	if len(data) > maxCatalogBytes {
		return fmt.Errorf("agent catalog: file exceeds %d bytes", maxCatalogBytes)
	}
	var defs []Definition
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&defs); err != nil {
		return fmt.Errorf("agent catalog: %w", err)
	}
	if dec.Decode(&struct{}{}) != io.EOF {
		return errors.New("agent catalog: trailing JSON value")
	}
	loaded := make(map[string]Definition, len(defs))
	for _, def := range defs {
		if _, err := validateDefinition(def); err != nil {
			return fmt.Errorf("agent catalog %q: %w", def.ID, err)
		}
		if _, exists := loaded[def.ID]; exists {
			return fmt.Errorf("agent catalog: duplicate id %q", def.ID)
		}
		loaded[def.ID] = cloneDefinition(def)
	}
	c.mu.Lock()
	c.defs = loaded
	c.mu.Unlock()
	return nil
}

func (c *Catalog) List() []Definition {
	c.mu.RLock()
	defs := make([]Definition, 0, len(c.defs))
	for _, def := range c.defs {
		defs = append(defs, cloneDefinition(def))
	}
	c.mu.RUnlock()
	sort.Slice(defs, func(i, j int) bool { return defs[i].ID < defs[j].ID })
	return defs
}

func (c *Catalog) Get(id string) (Definition, bool) {
	c.mu.RLock()
	def, ok := c.defs[id]
	c.mu.RUnlock()
	return cloneDefinition(def), ok
}

// Upsert validates and atomically persists the complete catalog before exposing the change.
func (c *Catalog) Upsert(def Definition) error {
	if _, err := validateDefinition(def); err != nil {
		return err
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	next := make(map[string]Definition, len(c.defs)+1)
	for id, current := range c.defs {
		next[id] = current
	}
	next[def.ID] = cloneDefinition(def)
	if err := c.save(next); err != nil {
		return err
	}
	c.defs = next
	return nil
}

func (c *Catalog) Delete(id string) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if _, ok := c.defs[id]; !ok {
		return nil
	}
	next := make(map[string]Definition, len(c.defs)-1)
	for currentID, def := range c.defs {
		if currentID != id {
			next[currentID] = def
		}
	}
	if err := c.save(next); err != nil {
		return err
	}
	c.defs = next
	return nil
}

func (c *Catalog) save(defs map[string]Definition) error {
	if c.path == "" {
		return errors.New("agent catalog: path is required")
	}
	list := make([]Definition, 0, len(defs))
	for _, def := range defs {
		list = append(list, def)
	}
	sort.Slice(list, func(i, j int) bool { return list[i].ID < list[j].ID })
	data, err := json.MarshalIndent(list, "", "  ")
	if err != nil {
		return fmt.Errorf("agent catalog: %w", err)
	}
	data = append(data, '\n')
	dir := filepath.Dir(c.path)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return fmt.Errorf("agent catalog: %w", err)
	}
	f, err := os.CreateTemp(dir, ".agents-*.tmp")
	if err != nil {
		return fmt.Errorf("agent catalog: %w", err)
	}
	tmp := f.Name()
	defer os.Remove(tmp)
	if err := f.Chmod(0o600); err == nil {
		_, err = f.Write(data)
	}
	if err == nil {
		err = f.Sync()
	}
	closeErr := f.Close()
	if err == nil {
		err = closeErr
	}
	if err != nil {
		return fmt.Errorf("agent catalog: %w", err)
	}
	if err := os.Rename(tmp, c.path); err != nil {
		return fmt.Errorf("agent catalog: %w", err)
	}
	return nil
}

func cloneDefinition(def Definition) Definition {
	def.Args = append([]string(nil), def.Args...)
	def.Env = append([]string(nil), def.Env...)
	def.ApprovedArgs = append([]string(nil), def.ApprovedArgs...)
	def.ApprovedEnv = append([]string(nil), def.ApprovedEnv...)
	return def
}

// Approve records the exact executable content and launch settings approved by the user.
func Approve(def Definition) (Definition, error) {
	executable, err := validateDefinition(def)
	if err != nil {
		return Definition{}, err
	}
	fingerprint, err := fingerprintExecutable(executable)
	if err != nil {
		return Definition{}, err
	}
	def.Trusted = true
	def.ApprovedExecutable = executable
	def.ApprovedSHA256 = fingerprint
	def.ApprovedArgs = append([]string(nil), def.Args...)
	def.ApprovedEnv = append([]string(nil), def.Env...)
	return def, nil
}

// VerifyTrusted revalidates both the launch settings and executable content.
func VerifyTrusted(def Definition) (string, error) {
	if !def.Trusted {
		return "", ErrUntrusted
	}
	executable, err := validateDefinition(def)
	if err != nil {
		return "", err
	}
	if def.ApprovedExecutable == "" || def.ApprovedSHA256 == "" ||
		def.ApprovedExecutable != executable ||
		!slices.Equal(def.ApprovedArgs, def.Args) || !slices.Equal(def.ApprovedEnv, def.Env) {
		return "", ErrTrustChanged
	}
	fingerprint, err := fingerprintExecutable(executable)
	if err != nil {
		return "", err
	}
	if fingerprint != def.ApprovedSHA256 {
		return "", ErrTrustChanged
	}
	return executable, nil
}

func fingerprintExecutable(executable string) (string, error) {
	f, err := os.Open(executable)
	if err != nil {
		return "", fmt.Errorf("agent: fingerprint executable: %w", err)
	}
	h := sha256.New()
	_, copyErr := io.Copy(h, f)
	closeErr := f.Close()
	if copyErr != nil {
		return "", fmt.Errorf("agent: fingerprint executable: %w", copyErr)
	}
	if closeErr != nil {
		return "", fmt.Errorf("agent: fingerprint executable: %w", closeErr)
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

func validateDefinition(def Definition) (string, error) {
	if strings.TrimSpace(def.ID) == "" || strings.ContainsRune(def.ID, 0) {
		return "", errors.New("agent: non-empty id without NUL is required")
	}
	if strings.TrimSpace(def.Name) == "" || strings.ContainsRune(def.Name, 0) {
		return "", errors.New("agent: non-empty name without NUL is required")
	}
	if def.Executable == "" || strings.ContainsRune(def.Executable, 0) {
		return "", errors.New("agent: executable without NUL is required")
	}
	for _, arg := range def.Args {
		if strings.ContainsRune(arg, 0) {
			return "", errors.New("agent: argv contains NUL")
		}
	}
	seen := make(map[string]struct{}, len(def.Env))
	for _, entry := range def.Env {
		key, _, err := validateEnv(entry)
		if err != nil {
			return "", err
		}
		if _, ok := seen[key]; ok {
			return "", fmt.Errorf("agent: duplicate environment variable %q", key)
		}
		seen[key] = struct{}{}
	}
	executable, err := exec.LookPath(def.Executable)
	if err != nil {
		return "", fmt.Errorf("agent: executable: %w", err)
	}
	executable, err = filepath.Abs(executable)
	if err != nil {
		return "", fmt.Errorf("agent: executable: %w", err)
	}
	info, err := os.Stat(executable)
	if err != nil || !info.Mode().IsRegular() {
		return "", errors.New("agent: executable is not a regular file")
	}
	if runtime.GOOS != "windows" && info.Mode().Perm()&0o111 == 0 {
		return "", errors.New("agent: executable has no execute bit")
	}
	return executable, nil
}

func validateEnv(entry string) (string, string, error) {
	key, value, ok := strings.Cut(entry, "=")
	if !ok || key == "" || strings.ContainsRune(entry, 0) {
		return "", "", fmt.Errorf("agent: invalid or disallowed environment entry %q", key)
	}
	for i, r := range key {
		if !(r == '_' || r >= 'A' && r <= 'Z' || r >= 'a' && r <= 'z' || i > 0 && r >= '0' && r <= '9') {
			return "", "", fmt.Errorf("agent: invalid environment variable %q", key)
		}
	}
	return strings.ToUpper(key), value, nil
}

func safeEnvName(key string) bool {
	upper := strings.ToUpper(key)
	if strings.HasPrefix(upper, "LC_") {
		return true
	}
	switch upper {
	case "PATH", "HOME", "USERPROFILE", "LANG", "TMPDIR", "TEMP", "TMP", "APPDATA", "LOCALAPPDATA", "SYSTEMROOT", "PATHEXT":
		return true
	}
	return false
}

func minimalEnv(additive []string) []string {
	entries := make(map[string]string)
	for _, entry := range os.Environ() {
		key, _, ok := strings.Cut(entry, "=")
		if ok && safeEnvName(key) {
			entries[strings.ToUpper(key)] = entry
		}
	}
	for _, entry := range additive {
		// Inherited credentials stay filtered; each additive entry is an
		// explicit per-agent opt-in validated by the catalog.
		key, _, _ := strings.Cut(entry, "=")
		entries[strings.ToUpper(key)] = entry
	}
	keys := make([]string, 0, len(entries))
	for key := range entries {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	env := make([]string, 0, len(keys))
	for _, key := range keys {
		env = append(env, entries[key])
	}
	return env
}
