package app

import (
	"context"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
)

func TestFetchOpenAIModels(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/models" {
			http.NotFound(w, r)
			return
		}
		if got := r.Header.Get("Authorization"); got != "Bearer secret" {
			t.Errorf("Authorization = %q", got)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"object":"list","data":[{"id":"model-b"},{"id":"model-a"},{"id":"model-b"},{"id":""}]}`))
	}))
	defer server.Close()

	ids, err := fetchOpenAIModels(context.Background(), server.URL+"/v1/", "secret")
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"model-b", "model-a"}
	if !reflect.DeepEqual(ids, want) {
		t.Fatalf("ids = %#v, want %#v", ids, want)
	}
}

func TestParseModelIDsAlternativeShapes(t *testing.T) {
	cases := []struct {
		name string
		body string
		want []string
	}{
		{"models envelope", `{"models":[{"id":"one"},{"id":"two"}]}`, []string{"one", "two"}},
		{"object array", `[{"id":"one"},{"id":"two"}]`, []string{"one", "two"}},
		{"string array", `["one","two"]`, []string{"one", "two"}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := parseModelIDs([]byte(tc.body))
			if err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(got, tc.want) {
				t.Fatalf("ids = %#v, want %#v", got, tc.want)
			}
		})
	}
}

func TestFetchOpenAIModelsReportsHTTPError(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "bad key", http.StatusUnauthorized)
	}))
	defer server.Close()

	_, err := fetchOpenAIModels(context.Background(), server.URL, "wrong")
	if err == nil {
		t.Fatal("expected an error")
	}
	if !strings.Contains(err.Error(), "401") || !strings.Contains(err.Error(), "bad key") {
		t.Fatalf("unexpected error: %v", err)
	}
}
