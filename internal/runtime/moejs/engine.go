// Package moejs runs the official Pi Durable bundle inside the Go process
// using moejs, a pure-Go JavaScript runtime.
package moejsruntime

import (
	"crypto/rand"
	"database/sql"
	"embed"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	moejs "github.com/MoeForge/moejs"
	"github.com/MoeForge/moejs/eventloop"
	"github.com/MoeForge/moejs/webapi"

	"github.com/QinYangWang/omo/internal/host"

	_ "modernc.org/sqlite"
)

//go:embed assets/bootstrap.js assets/pi-durable.js
var assets embed.FS

type Event struct {
	Kind    string
	Message string
}

// TeamConfig opens one team: one durable database, one conversation per Bot.
type TeamConfig struct {
	DBPath       string            `json:"dbPath"`
	TeamID       string            `json:"teamId,omitempty"`
	BaseURL      string            `json:"baseUrl"`
	Provider     string            `json:"provider"`
	Model        string            `json:"model"`
	CustomModels []string          `json:"customModels,omitempty"`
	Workspace    string            `json:"workspace"`
	Credentials  map[string]string `json:"credentials"`
	MaxTokens    int               `json:"maxTokens"`
	Temperature  float64           `json:"temperature"`
	MaxTurns     int               `json:"maxTurns,omitempty"`
	Skills       []Skill           `json:"skills,omitempty"`
	Bots         []TeamBot         `json:"bots"`
}

// TeamBot is one roster entry handed to the runtime, with the durable
// conversation it already owns (empty on the first open).
type TeamBot struct {
	ID             string `json:"id"`
	Name           string `json:"name"`
	Instructions   string `json:"instructions,omitempty"`
	Provider       string `json:"provider,omitempty"`
	Model          string `json:"model,omitempty"`
	ConversationID string `json:"conversationId,omitempty"`
}

// Skill is one markdown instruction pack the Go host discovered on disk and
// handed to the agent runtime. The runtime lists it in the system prompt and
// loads it through the use_skill tool.
type Skill struct {
	Name        string `json:"name"`
	Description string `json:"description"`
	Path        string `json:"path"`
	Content     string `json:"content"`
}

type CatalogModel struct {
	ID            string   `json:"id"`
	Name          string   `json:"name"`
	API           string   `json:"api"`
	Reasoning     bool     `json:"reasoning"`
	Input         []string `json:"input"`
	ContextWindow int      `json:"contextWindow"`
	MaxTokens     int      `json:"maxTokens"`
}

type CatalogProvider struct {
	ID       string         `json:"id"`
	Name     string         `json:"name"`
	BaseURL  string         `json:"baseUrl"`
	AuthName string         `json:"authName"`
	Models   []CatalogModel `json:"models"`
}

type Catalog struct {
	Providers []CatalogProvider `json:"providers"`
}

type Engine struct {
	loop    *eventloop.Loop
	rt      *moejs.Runtime
	exports map[string]moejs.Value
	events  chan Event
	logf    func(format string, args ...any)

	mu      sync.Mutex
	ws      *host.Workspace
	db      *sql.DB
	closed  bool
	started bool
}

func New(logf func(string, ...any)) (*Engine, error) {
	if logf == nil {
		logf = func(string, ...any) {}
	}
	e := &Engine{exports: map[string]moejs.Value{}, events: make(chan Event, 256), logf: logf}
	rt := moejs.NewRuntime(moejs.Options{})
	rt.SetPromiseRejectionTracker(func(_ moejs.Value, op moejs.PromiseRejectionOperation) {
		logf("js: unhandled promise rejection (op=%v)", op)
	})
	loop, err := eventloop.New(rt, eventloop.Options{
		OnError: func(err error) {
			logf("js loop error: %v", err)
			e.emit(Event{Kind: "error", Message: err.Error()})
		},
	})
	if err != nil {
		return nil, err
	}
	api, err := webapi.Install(loop, webapi.Options{
		Client: &http.Client{Timeout: 10 * time.Minute},
	})
	if err != nil {
		return nil, err
	}
	e.rt = rt
	e.loop = loop
	if err := e.register(); err != nil {
		api.Close()
		return nil, err
	}
	if err := loop.Start(); err != nil {
		api.Close()
		return nil, err
	}
	e.started = true
	if err := e.load(); err != nil {
		loop.Stop()
		api.Close()
		return nil, err
	}
	return e, nil
}

func (e *Engine) Events() <-chan Event { return e.events }

func (e *Engine) emit(ev Event) {
	select {
	case e.events <- ev:
	default:
	}
}

func (e *Engine) register() error {
	register := moejs.NativeFunc(func(_ *moejs.Realm, _ moejs.Value, args []moejs.Value) (moejs.Value, error) {
		name := moejs.Arg(args, 0).String()
		e.exports[name] = moejs.Arg(args, 1)
		return moejs.Undefined(), nil
	})
	if err := e.rt.SetGlobal("__pi_register", register); err != nil {
		return err
	}

	randomFn := moejs.NativeFunc(func(_ *moejs.Realm, _ moejs.Value, args []moejs.Value) (moejs.Value, error) {
		n, err := argInt(e.rt, args, 0)
		if err != nil {
			return moejs.Undefined(), err
		}
		if n < 0 || n > 1<<20 {
			return moejs.Undefined(), fmt.Errorf("random size out of range")
		}
		buf := make([]byte, n)
		if _, err := rand.Read(buf); err != nil {
			return moejs.Undefined(), err
		}
		return moejs.String(hex.EncodeToString(buf)), nil
	})
	if err := e.rt.SetGlobal("__host_random", randomFn); err != nil {
		return err
	}

	logFn := moejs.NativeFunc(func(_ *moejs.Realm, _ moejs.Value, args []moejs.Value) (moejs.Value, error) {
		e.logf("js[%s] %s", moejs.Arg(args, 0).String(), moejs.Arg(args, 1).String())
		return moejs.Undefined(), nil
	})
	if err := e.rt.SetGlobal("__host_log", logFn); err != nil {
		return err
	}

	fsFn := moejs.NativeFunc(func(_ *moejs.Realm, _ moejs.Value, args []moejs.Value) (moejs.Value, error) {
		op := moejs.Arg(args, 0).String()
		var req map[string]any
		if err := json.Unmarshal([]byte(moejs.Arg(args, 1).String()), &req); err != nil {
			return moejs.Undefined(), err
		}
		out, err := e.handleFS(op, req)
		if err != nil {
			return moejs.Undefined(), err
		}
		data, err := json.Marshal(out)
		if err != nil {
			return moejs.Undefined(), err
		}
		return moejs.String(string(data)), nil
	})
	if err := e.rt.SetGlobal("__host_fs", fsFn); err != nil {
		return err
	}

	sqlFn := moejs.NativeFunc(func(_ *moejs.Realm, _ moejs.Value, args []moejs.Value) (moejs.Value, error) {
		var req sqlRequest
		if err := json.Unmarshal([]byte(moejs.Arg(args, 0).String()), &req); err != nil {
			return moejs.Undefined(), err
		}
		out, err := e.handleSQL(req)
		if err != nil {
			return moejs.Undefined(), err
		}
		return moejs.String(out), nil
	})
	if err := e.rt.SetGlobal("__host_sql", sqlFn); err != nil {
		return err
	}

	// Metrics and the agent graph are reported by the runtime and persisted by
	// the app; a rejected report must never break the agent loop.
	emitFn := func(kind string) moejs.NativeFunc {
		return moejs.NativeFunc(func(_ *moejs.Realm, _ moejs.Value, args []moejs.Value) (moejs.Value, error) {
			e.emit(Event{Kind: kind, Message: moejs.Arg(args, 0).String()})
			return moejs.Undefined(), nil
		})
	}
	if err := e.rt.SetGlobal("__host_metric", emitFn("metric")); err != nil {
		return err
	}
	return e.rt.SetGlobal("__host_agent", emitFn("agent"))
}

func (e *Engine) load() error {
	bootstrap, err := assets.ReadFile("assets/bootstrap.js")
	if err != nil {
		return err
	}
	bundle, err := assets.ReadFile("assets/pi-durable.js")
	if err != nil {
		return err
	}
	prelude, err := moejs.CompileScript("bootstrap.js", string(bootstrap))
	if err != nil {
		return err
	}
	script, err := moejs.CompileScript("pi-durable.js", string(bundle))
	if err != nil {
		return err
	}
	done := make(chan error, 1)
	posted := eventloop.Post(e.loop, func(rt *moejs.Runtime) error {
		if _, runErr := rt.RunScript(prelude); runErr != nil {
			wrapped := fmt.Errorf("bootstrap: %w", runErr)
			done <- wrapped
			return wrapped
		}
		if _, runErr := rt.RunScript(script); runErr != nil {
			wrapped := fmt.Errorf("pi-durable bundle: %w", runErr)
			done <- wrapped
			return wrapped
		}
		for _, name := range []string{"openTeam", "sendToBot", "abortBot", "closeTeam", "listCatalog"} {
			if _, ok := e.exports[name]; !ok {
				missing := fmt.Errorf("bundle did not register %s", name)
				done <- missing
				return missing
			}
		}
		done <- nil
		return nil
	})
	if !posted {
		return errors.New("runtime loop is not running")
	}
	select {
	case err := <-done:
		return err
	case <-time.After(15 * time.Second):
		return errors.New("timed out loading the pi-durable bundle")
	}
}

// ListCatalog returns the provider and chat-model catalog that pi-ai
// registered in the running bundle. The app treats it as read-only data.
func (e *Engine) ListCatalog(baseURL, model string, customModels []string) (Catalog, error) {
	var out Catalog
	models, err := json.Marshal(customModels)
	if err != nil {
		return out, err
	}
	value, err := e.callSync("listCatalog", func(rt *moejs.Runtime) ([]moejs.Value, error) {
		return []moejs.Value{moejs.String(baseURL), moejs.String(model), moejs.String(string(models))}, nil
	})
	if err != nil {
		return out, err
	}
	if err := json.Unmarshal([]byte(value.String()), &out); err != nil {
		return out, fmt.Errorf("decode pi-ai catalog: %w", err)
	}
	return out, nil
}

func (e *Engine) SetWorkspace(ws *host.Workspace) {
	e.mu.Lock()
	e.ws = ws
	e.mu.Unlock()
}

// SetWorkspaceDir opens dir as the workspace the tools may touch.
func (e *Engine) SetWorkspaceDir(dir string) error {
	ws, err := host.Open(dir)
	if err != nil {
		return err
	}
	e.SetWorkspace(ws)
	return nil
}

// OpenTeam opens the team database and every Bot conversation in the runtime.
func (e *Engine) OpenTeam(cfg TeamConfig) error {
	if cfg.DBPath == "" {
		return errors.New("session database path is empty")
	}
	if err := os.MkdirAll(filepath.Dir(cfg.DBPath), 0o700); err != nil {
		return err
	}
	db, err := sql.Open("sqlite", cfg.DBPath)
	if err != nil {
		return err
	}
	db.SetMaxOpenConns(1)
	if _, err := db.Exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;"); err != nil {
		db.Close()
		return err
	}
	e.mu.Lock()
	if e.db != nil {
		e.db.Close()
	}
	e.db = db
	e.mu.Unlock()

	payload, err := json.Marshal(cfg)
	if err != nil {
		return err
	}
	return e.callAsync("openTeam", func(rt *moejs.Runtime) ([]moejs.Value, error) {
		cfgValue, err := rt.ParseJSON(payload)
		if err != nil {
			return nil, err
		}
		onEvent, err := e.eventValue(rt)
		if err != nil {
			return nil, err
		}
		return []moejs.Value{cfgValue, onEvent}, nil
	})
}

// SendTo submits one user message to one Bot.
func (e *Engine) SendTo(botID, text string) error {
	return e.callAsync("sendToBot", func(rt *moejs.Runtime) ([]moejs.Value, error) {
		onDone, err := e.funcValue(rt, func(jsonText string) {
			e.emit(Event{Kind: "sent", Message: jsonText})
		})
		if err != nil {
			return nil, err
		}
		return []moejs.Value{moejs.String(botID), moejs.String(text), onDone}, nil
	})
}

// AbortBot stops the current work of one Bot.
func (e *Engine) AbortBot(botID string) error {
	return e.callAsync("abortBot", func(rt *moejs.Runtime) ([]moejs.Value, error) {
		onDone, err := e.funcValue(rt, func(jsonText string) {
			e.emit(Event{Kind: "aborted", Message: jsonText})
		})
		if err != nil {
			return nil, err
		}
		return []moejs.Value{moejs.String(botID), onDone}, nil
	})
}

func (e *Engine) Close() {
	e.mu.Lock()
	if e.closed {
		e.mu.Unlock()
		return
	}
	e.closed = true
	db := e.db
	e.db = nil
	e.mu.Unlock()

	done := make(chan struct{})
	if e.started {
		_ = eventloop.Post(e.loop, func(rt *moejs.Runtime) error {
			defer close(done)
			fn, ok := e.exports["closeTeam"]
			if !ok {
				return nil
			}
			p, err := rt.CallFunction(fn, moejs.Undefined())
			if err != nil {
				return nil
			}
			_ = p
			return nil
		})
		select {
		case <-done:
		case <-time.After(2 * time.Second):
		}
		_ = e.loop.Stop()
	}
	if db != nil {
		db.Close()
	}
}

// callAsync posts a call on the runtime's loop. The JS function's returned
// promise is not awaited; the function reports through its callbacks.
func (e *Engine) callAsync(name string, build func(*moejs.Runtime) ([]moejs.Value, error)) error {
	fn, ok := e.exports[name]
	if !ok {
		return fmt.Errorf("runtime function %s is not registered", name)
	}
	if !eventloop.Post(e.loop, func(rt *moejs.Runtime) error {
		args, err := build(rt)
		if err != nil {
			return err
		}
		if _, err := rt.CallFunction(fn, moejs.Undefined(), args...); err != nil {
			return fmt.Errorf("%s: %w", name, err)
		}
		return nil
	}) {
		return errors.New("runtime loop is not running")
	}
	return nil
}

type syncCallResult struct {
	value moejs.Value
	err   error
}

// callSync runs a synchronous JS function on the runtime loop and waits for
// its return value. It must not be called from the loop goroutine.
func (e *Engine) callSync(name string, build func(*moejs.Runtime) ([]moejs.Value, error)) (moejs.Value, error) {
	fn, ok := e.exports[name]
	if !ok {
		return moejs.Undefined(), fmt.Errorf("runtime function %s is not registered", name)
	}
	done := make(chan syncCallResult, 1)
	if !eventloop.Post(e.loop, func(rt *moejs.Runtime) error {
		args, err := build(rt)
		if err != nil {
			done <- syncCallResult{err: err}
			return err
		}
		value, err := rt.CallFunction(fn, moejs.Undefined(), args...)
		done <- syncCallResult{value: value, err: err}
		return err
	}) {
		return moejs.Undefined(), errors.New("runtime loop is not running")
	}
	result := <-done
	return result.value, result.err
}

func (e *Engine) funcValue(rt *moejs.Runtime, fn func(string)) (moejs.Value, error) {
	native := moejs.NativeFunc(func(_ *moejs.Realm, _ moejs.Value, args []moejs.Value) (moejs.Value, error) {
		fn(moejs.Arg(args, 0).String())
		return moejs.Undefined(), nil
	})
	return rt.FromGo(native)
}

// eventValue is the runtime's (kind, json) reporter. Every event reaches the
// app; a rejected report must not fail a run.
func (e *Engine) eventValue(rt *moejs.Runtime) (moejs.Value, error) {
	native := moejs.NativeFunc(func(_ *moejs.Realm, _ moejs.Value, args []moejs.Value) (moejs.Value, error) {
		e.emit(Event{Kind: moejs.Arg(args, 0).String(), Message: moejs.Arg(args, 1).String()})
		return moejs.Undefined(), nil
	})
	return rt.FromGo(native)
}

func argInt(rt *moejs.Runtime, args []moejs.Value, index int) (int, error) {
	raw, err := rt.ToGo(moejs.Arg(args, index))
	if err != nil {
		return 0, err
	}
	f, _ := raw.(float64)
	return int(f), nil
}

func (e *Engine) handleFS(op string, req map[string]any) (any, error) {
	e.mu.Lock()
	ws := e.ws
	e.mu.Unlock()
	if ws == nil {
		return nil, errors.New("no workspace is open")
	}
	str := func(key string) string {
		v, _ := req[key].(string)
		return v
	}
	num := func(key string) int {
		v, _ := req[key].(float64)
		return int(v)
	}
	switch op {
	case "list":
		return ws.List(str("path"))
	case "read":
		return ws.Read(str("path"), num("start_line"), num("end_line"))
	case "write":
		return ws.Write(str("path"), str("content"))
	case "search":
		return ws.Search(str("query"), str("path"), num("max_results"))
	default:
		return nil, fmt.Errorf("unknown file operation %q", op)
	}
}

type sqlRequest struct {
	Op     string            `json:"op"`
	SQL    string            `json:"sql"`
	Params []json.RawMessage `json:"params"`
}

func (e *Engine) handleSQL(req sqlRequest) (string, error) {
	e.mu.Lock()
	db := e.db
	e.mu.Unlock()
	if db == nil {
		return "", errors.New("no session database is open")
	}
	params := make([]any, 0, len(req.Params))
	for _, raw := range req.Params {
		value, err := decodeSQLValue(raw)
		if err != nil {
			return "", err
		}
		params = append(params, value)
	}
	switch req.Op {
	case "exec", "run":
		res, err := db.Exec(req.SQL, params...)
		if err != nil {
			return "", err
		}
		changes, _ := res.RowsAffected()
		return fmt.Sprintf(`{"changes":%d}`, changes), nil
	case "get", "all":
		rows, err := db.Query(req.SQL, params...)
		if err != nil {
			return "", err
		}
		defer rows.Close()
		out, err := scanRows(rows, req.Op == "get")
		if err != nil {
			return "", err
		}
		data, err := json.Marshal(map[string]any{"rows": out})
		return string(data), err
	default:
		return "", fmt.Errorf("unknown sql operation %q", req.Op)
	}
}

func decodeSQLValue(raw json.RawMessage) (any, error) {
	var v any
	if err := json.Unmarshal(raw, &v); err != nil {
		return nil, err
	}
	switch value := v.(type) {
	case map[string]any:
		if b, ok := value["$b"].(string); ok {
			data, err := base64.StdEncoding.DecodeString(b)
			if err != nil {
				return nil, err
			}
			return data, nil
		}
		if s, ok := value["$i"].(string); ok {
			var n int64
			if _, err := fmt.Sscan(s, &n); err != nil {
				return nil, err
			}
			return n, nil
		}
		return value, nil
	case float64:
		if value == math.Trunc(value) && math.Abs(value) < 1<<53 {
			return int64(value), nil
		}
		return value, nil
	default:
		return v, nil
	}
}

func scanRows(rows *sql.Rows, single bool) ([]map[string]any, error) {
	cols, err := rows.Columns()
	if err != nil {
		return nil, err
	}
	var out []map[string]any
	for rows.Next() {
		values := make([]any, len(cols))
		ptrs := make([]any, len(cols))
		for i := range values {
			ptrs[i] = &values[i]
		}
		if err := rows.Scan(ptrs...); err != nil {
			return nil, err
		}
		row := make(map[string]any, len(cols))
		for i, name := range cols {
			row[name] = encodeSQLValue(values[i])
		}
		out = append(out, row)
		if single {
			break
		}
	}
	return out, rows.Err()
}

func encodeSQLValue(v any) any {
	switch value := v.(type) {
	case []byte:
		return map[string]string{"$b": base64.StdEncoding.EncodeToString(value)}
	case int64:
		return value
	case time.Time:
		return value.UTC().Format(time.RFC3339Nano)
	default:
		return v
	}
}

func (e *Engine) String() string {
	e.mu.Lock()
	defer e.mu.Unlock()
	names := make([]string, 0, len(e.exports))
	for name := range e.exports {
		names = append(names, name)
	}
	return "moejs engine exports: " + strings.Join(names, ", ")
}
