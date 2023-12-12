package utils

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"time"

	"github.com/go-errors/errors"
	openapi "github.com/supabase/cli/pkg/api"
)

var httpClient = http.Client{Timeout: 10 * time.Second}

func JsonResponse[T any](ctx context.Context, method, url string, reqBody any, reqEditors ...openapi.RequestEditorFn) (*T, error) {
	var body bytes.Buffer
	if reqBody != nil {
		enc := json.NewEncoder(&body)
		if err := enc.Encode(reqBody); err != nil {
			return nil, errors.Errorf("failed to encode request body: %w", err)
		}
		reqEditors = append(reqEditors, func(ctx context.Context, req *http.Request) error {
			req.Header.Set("Content-Type", "application/json")
			return nil
		})
	}
	// Creates request
	req, err := http.NewRequestWithContext(ctx, method, url, &body)
	if err != nil {
		return nil, errors.Errorf("failed to initialise http request: %w", err)
	}
	for _, edit := range reqEditors {
		if err := edit(ctx, req); err != nil {
			return nil, err
		}
	}
	req.Header.Set("User-Agent", "SupabaseCLI/"+Version)
	// Sends request
	resp, err := httpClient.Do(req)
	if err != nil {
		return nil, errors.Errorf("failed to execute http request: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		data, err := io.ReadAll(resp.Body)
		if err != nil {
			return nil, errors.Errorf("failed to read response body: %w", err)
		}
		return nil, errors.Errorf("Error status %d: %s", resp.StatusCode, data)
	}
	// Parses response
	var data T
	dec := json.NewDecoder(resp.Body)
	if err := dec.Decode(&data); err != nil {
		return nil, errors.Errorf("failed to parse response body: %w", err)
	}
	return &data, nil
}

func TextResponse(ctx context.Context, method, url string, body io.Reader, reqEditors ...openapi.RequestEditorFn) (string, error) {
	req, err := http.NewRequestWithContext(ctx, method, url, body)
	if err != nil {
		return "", errors.Errorf("failed to initialise http request: %w", err)
	}
	for _, edit := range reqEditors {
		if err := edit(ctx, req); err != nil {
			return "", err
		}
	}
	req.Header.Set("User-Agent", "SupabaseCLI/"+Version)
	// Sends request
	resp, err := httpClient.Do(req)
	if err != nil {
		return "", errors.Errorf("failed to execute http request: %w", err)
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(resp.Body)
	if err != nil {
		return "", errors.Errorf("failed to read response body: %w", err)
	}
	if resp.StatusCode != http.StatusOK {
		return "", errors.Errorf("Error status %d: %s", resp.StatusCode, body)
	}
	return string(data), nil
}
