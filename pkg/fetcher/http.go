package fetcher

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"

	"github.com/go-errors/errors"
)

type Fetcher struct {
	server  string
	client  *http.Client
	editors []RequestEditorFn
}

type FetcherOption func(*Fetcher)

func NewFetcher(server string, opts ...FetcherOption) *Fetcher {
	api := &Fetcher{
		server: server,
		client: http.DefaultClient,
	}
	for _, apply := range opts {
		apply(api)
	}
	return api
}

func WithHTTPClient(client *http.Client) FetcherOption {
	return func(s *Fetcher) {
		s.client = client
	}
}

func WithBearerToken(token string) FetcherOption {
	reqEditor := func(_ context.Context, req *http.Request) error {
		req.Header.Add("Authorization", "Bearer "+token)
		return nil
	}
	return func(s *Fetcher) {
		s.editors = append(s.editors, reqEditor)
	}
}

func WithUserAgent(agent string) FetcherOption {
	reqEditor := func(_ context.Context, req *http.Request) error {
		req.Header.Add("User-Agent", agent)
		return nil
	}
	return func(s *Fetcher) {
		s.editors = append(s.editors, reqEditor)
	}
}

type RequestEditorFn func(ctx context.Context, req *http.Request) error

func (s *Fetcher) Send(ctx context.Context, method, path string, reqBody any, reqEditors ...RequestEditorFn) (*http.Response, error) {
	body, ok := reqBody.(io.Reader)
	if !ok && reqBody != nil {
		var buf bytes.Buffer
		enc := json.NewEncoder(&buf)
		if err := enc.Encode(reqBody); err != nil {
			return nil, errors.Errorf("failed to encode request body: %w", err)
		}
		reqEditors = append(reqEditors, func(ctx context.Context, req *http.Request) error {
			req.Header.Set("Content-Type", "application/json")
			return nil
		})
		body = &buf
	}
	// Creates request
	req, err := http.NewRequestWithContext(ctx, method, s.server+path, body)
	if err != nil {
		return nil, errors.Errorf("failed to initialise http request: %w", err)
	}
	for _, apply := range s.editors {
		if err := apply(ctx, req); err != nil {
			return nil, err
		}
	}
	for _, apply := range reqEditors {
		if err := apply(ctx, req); err != nil {
			return nil, err
		}
	}
	// Sends request
	resp, err := s.client.Do(req)
	if err != nil {
		return nil, errors.Errorf("failed to execute http request: %w", err)
	}
	if resp.StatusCode >= http.StatusBadRequest {
		defer resp.Body.Close()
		data, err := io.ReadAll(resp.Body)
		if err != nil {
			return nil, errors.Errorf("Error status %d: %w", resp.StatusCode, err)
		}
		return nil, errors.Errorf("Error status %d: %s", resp.StatusCode, data)
	}
	return resp, nil
}

func ParseJSON[T any](r io.Reader) (*T, error) {
	var data T
	dec := json.NewDecoder(r)
	if err := dec.Decode(&data); err != nil {
		return nil, errors.Errorf("failed to parse response body: %w", err)
	}
	return &data, nil
}
