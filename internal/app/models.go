package app

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

const modelListLimit = 8 << 20

// fetchOpenAIModels asks an OpenAI-compatible endpoint for its model IDs.
// It deliberately returns IDs only: the endpoint does not report pi-ai
// capabilities such as reasoning support or context size.
func fetchOpenAIModels(ctx context.Context, baseURL, apiKey string) ([]string, error) {
	baseURL = strings.TrimRight(strings.TrimSpace(baseURL), "/")
	if baseURL == "" {
		return nil, errors.New("base URL is empty")
	}
	endpoint := baseURL + "/models"
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return nil, fmt.Errorf("build %s request: %w", endpoint, err)
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", "omo/0.1")
	if key := strings.TrimSpace(apiKey); key != "" {
		req.Header.Set("Authorization", "Bearer "+key)
	}

	client := &http.Client{Timeout: 20 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("GET %s: %w", endpoint, err)
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, modelListLimit+1))
	if err != nil {
		return nil, fmt.Errorf("read %s response: %w", endpoint, err)
	}
	if len(body) > modelListLimit {
		return nil, fmt.Errorf("%s response is larger than %d bytes", endpoint, modelListLimit)
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		detail := strings.TrimSpace(string(body))
		if len(detail) > 300 {
			detail = detail[:300] + "..."
		}
		if detail == "" {
			detail = http.StatusText(resp.StatusCode)
		}
		return nil, fmt.Errorf("GET %s returned %s: %s", endpoint, resp.Status, detail)
	}
	ids, err := parseModelIDs(body)
	if err != nil {
		return nil, fmt.Errorf("decode %s response: %w", endpoint, err)
	}
	return ids, nil
}

func parseModelIDs(body []byte) ([]string, error) {
	body = []byte(strings.TrimSpace(strings.TrimPrefix(string(body), "\ufeff")))
	if len(body) == 0 {
		return nil, errors.New("empty response")
	}
	var ids []string
	switch body[0] {
	case '[':
		var err error
		ids, err = decodeModelIDList(body)
		if err != nil {
			return nil, err
		}
	case '{':
		var envelope map[string]json.RawMessage
		if err := json.Unmarshal(body, &envelope); err != nil {
			return nil, err
		}
		raw := envelope["data"]
		if len(raw) == 0 {
			raw = envelope["models"]
		}
		if len(raw) == 0 {
			return nil, errors.New("response has no data or models array")
		}
		var err error
		ids, err = decodeModelIDList(raw)
		if err != nil {
			return nil, err
		}
	default:
		return nil, errors.New("response is not JSON")
	}

	seen := make(map[string]bool, len(ids))
	out := make([]string, 0, len(ids))
	for _, id := range ids {
		id = strings.TrimSpace(id)
		if id == "" || seen[id] {
			continue
		}
		seen[id] = true
		out = append(out, id)
	}
	if len(out) == 0 {
		return nil, errors.New("response contains no model IDs")
	}
	return out, nil
}

func decodeModelIDList(raw []byte) ([]string, error) {
	var objects []struct {
		ID string `json:"id"`
	}
	if err := json.Unmarshal(raw, &objects); err == nil {
		ids := make([]string, 0, len(objects))
		for _, object := range objects {
			ids = append(ids, object.ID)
		}
		return ids, nil
	}
	var stringsOnly []string
	if err := json.Unmarshal(raw, &stringsOnly); err == nil {
		return stringsOnly, nil
	}
	return nil, errors.New("expected an array of objects with id or an array of strings")
}
