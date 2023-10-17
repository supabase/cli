package utils

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"

	openapi "github.com/supabase/cli/pkg/api"
)

var httpClient = http.Client{Timeout: 10 * time.Second}

func JsonResponse[T any](ctx context.Context, method, url string, reqBody any, reqEditors ...openapi.RequestEditorFn) (*T, error) {
	var body bytes.Buffer
	if reqBody != nil {
		enc := json.NewEncoder(&body)
		if err := enc.Encode(reqBody); err != nil {
			return nil, err
		}
		reqEditors = append(reqEditors, func(ctx context.Context, req *http.Request) error {
			req.Header.Set("Content-Type", "application/json")
			return nil
		})
	}
	// Creates request
	req, err := http.NewRequestWithContext(ctx, method, url, &body)
	if err != nil {
		return nil, err
	}
	for _, edit := range reqEditors {
		if err := edit(ctx, req); err != nil {
			return nil, err
		}
	}
	// Sends request
	resp, err := httpClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		data, err := io.ReadAll(resp.Body)
		if err != nil {
			return nil, err
		}
		return nil, fmt.Errorf("Error status %d: %s", resp.StatusCode, data)
	}
	// Parses response
	var data T
	dec := json.NewDecoder(resp.Body)
	if err := dec.Decode(&data); err != nil {
		return nil, err
	}
	return &data, nil
}

func TextResponse(ctx context.Context, method, url string, body io.Reader, reqEditors ...openapi.RequestEditorFn) (string, error) {
	req, err := http.NewRequestWithContext(ctx, method, url, body)
	if err != nil {
		return "", err
	}
	for _, edit := range reqEditors {
		if err := edit(ctx, req); err != nil {
			return "", err
		}
	}
	// Sends request
	resp, err := httpClient.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(resp.Body)
	if err != nil {
		return "", err
	}
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("Error status %d: %s", resp.StatusCode, body)
	}
	return string(data), nil
}
