// Smoketest drives the same engine the desktop window uses, without a
// window, so the runtime path can be verified from a terminal.
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"time"

	"github.com/QinYangWang/omo/internal/config"
	moejsruntime "github.com/QinYangWang/omo/internal/runtime/moejs"
)

func main() {
	dataDir := flag.String("data", ".data", "app data directory")
	workspace := flag.String("workspace", "", "workspace directory (default: a temp sample)")
	prompt := flag.String("prompt", "List the files in the workspace, read sample.txt and tell me what it says.", "prompt")
	timeout := flag.Duration("timeout", 3*time.Minute, "overall timeout")
	dbPath := flag.String("db", "", "durable database path (reuse it to test reopening a session)")
	abortAfter := flag.Duration("abort-after", 0, "abort the run after this delay (0: never)")
	listCatalog := flag.Bool("catalog", false, "print the pi-ai provider/model catalog and exit")
	flag.Parse()

	cfg, err := config.Load(*dataDir)
	if err != nil {
		log.Fatal(err)
	}
	if !cfg.Ready() {
		log.Fatal("settings or API key missing")
	}

	wsDir := *workspace
	if wsDir == "" {
		wsDir, err = os.MkdirTemp("", "omo-smoke-")
		if err != nil {
			log.Fatal(err)
		}
		_ = os.WriteFile(filepath.Join(wsDir, "sample.txt"), []byte("hello from the workspace\n"), 0o644)
		_ = os.WriteFile(filepath.Join(wsDir, "notes.md"), []byte("# Notes\n\nsecond file\n"), 0o644)
	}
	fmt.Println("workspace:", wsDir)

	engine, err := moejsruntime.New(func(format string, args ...any) { log.Printf(format, args...) })
	if err != nil {
		log.Fatal(err)
	}
	defer engine.Close()
	if *listCatalog {
		catalog, err := engine.ListCatalog(cfg.Settings.BaseURL, cfg.Settings.Model, nil)
		if err != nil {
			log.Fatal(err)
		}
		total := 0
		for _, provider := range catalog.Providers {
			total += len(provider.Models)
			fmt.Printf("%s\t%s\t%d models\n", provider.ID, provider.Name, len(provider.Models))
		}
		fmt.Printf("TOTAL %d providers, %d chat models\n", len(catalog.Providers), total)
		return
	}

	// The harness needs a workspace object for the tools.
	if err := engine.SetWorkspaceDir(wsDir); err != nil {
		log.Fatal(err)
	}
	durableDB := *dbPath
	if durableDB == "" {
		durableDB = filepath.Join(os.TempDir(), fmt.Sprintf("omo-smoke-%d.db", time.Now().UnixNano()))
	}
	if err := engine.OpenSession(moejsruntime.SessionConfig{
		DBPath:      durableDB,
		BaseURL:     cfg.Settings.BaseURL,
		Provider:    cfg.Settings.Provider,
		Model:       cfg.Settings.Model,
		Workspace:   wsDir,
		Credentials: cfg.Credentials,
		MaxTokens:   cfg.Settings.MaxTokens,
		Temperature: cfg.Settings.Temperature,
	}); err != nil {
		log.Fatal(err)
	}
	time.Sleep(time.Second)

	if err := engine.Send(*prompt); err != nil {
		log.Fatal(err)
	}
	if *abortAfter > 0 {
		go func() {
			time.Sleep(*abortAfter)
			fmt.Println("ABORTING")
			if err := engine.Abort(); err != nil {
				fmt.Println("abort error:", err)
			}
		}()
	}
	deadline := time.After(*timeout)
	for {
		select {
		case ev := <-engine.Events():
			switch ev.Kind {
			case "state":
				var snap struct {
					Ready    bool   `json:"ready"`
					Status   string `json:"status"`
					Partial  string `json:"partial"`
					Failure  string `json:"failure"`
					Messages []struct {
						Role string `json:"role"`
						Text string `json:"text"`
					} `json:"messages"`
					Tool *struct {
						Name   string `json:"name"`
						Status string `json:"status"`
					} `json:"tool"`
				}
				if err := json.Unmarshal([]byte(ev.Message), &snap); err != nil {
					continue
				}
				last := ""
				if n := len(snap.Messages); n > 0 {
					last = snap.Messages[n-1].Text
					if len(last) > 160 {
						last = last[:160] + "…"
					}
				}
				fmt.Printf("[state] ready=%v status=%s msgs=%d partial=%d tool=%v last=%q\n",
					snap.Ready, snap.Status, len(snap.Messages), len(snap.Partial), snap.Tool, last)
				if snap.Failure != "" {
					fmt.Println("FAILURE:", snap.Failure)
				}
			case "sent":
				fmt.Println("[sent] final snapshot:", ev.Message)
				fmt.Println("PASS")
				return
			}
		case <-deadline:
			log.Fatal("timed out")
		}
	}
}
