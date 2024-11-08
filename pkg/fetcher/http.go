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
	editors []RequestEditor
	status  []int
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

func WithExpectedStatus(statusCode ...int) FetcherOption {
	return func(s *Fetcher) {
		s.status = statusCode
	}
}

func WithBearerToken(token string) FetcherOption {
	addHeader := func(req *http.Request) {
		req.Header.Add("Authorization", "Bearer "+token)
	}
	return WithRequestEditor(addHeader)
}

func WithUserAgent(agent string) FetcherOption {
	addHeader := func(req *http.Request) {
		req.Header.Add("User-Agent", agent)
	}
	return WithRequestEditor(addHeader)
}

func WithRequestEditor(fn RequestEditor) FetcherOption {
	return func(s *Fetcher) {
		s.editors = append(s.editors, fn)
	}
}

type RequestEditor func(req *http.Request)

func (s *Fetcher) Send(ctx context.Context, method, path string, reqBody any, reqEditors ...RequestEditor) (*http.Response, error) {
	body, ok := reqBody.(io.Reader)
	if !ok && reqBody != nil {
		var buf bytes.Buffer
		enc := json.NewEncoder(&buf)
		if err := enc.Encode(reqBody); err != nil {
			return nil, errors.Errorf("failed to encode request body: %w", err)
		}
		reqEditors = append(reqEditors, func(req *http.Request) {
			req.Header.Set("Content-Type", "application/json")
		})
		body = &buf
	}
	// Creates request
	req, err := http.NewRequestWithContext(ctx, method, s.server+path, body)
	if err != nil {
		return nil, errors.Errorf("failed to initialise http request: %w", err)
	}
	for _, apply := range s.editors {
		apply(req)
	}
	for _, apply := range reqEditors {
		apply(req)
	}
	// Sends request
	resp, err := s.client.Do(req)
	if err != nil {
		return nil, errors.Errorf("failed to execute http request: %w", err)
	}
	for _, expected := range s.status {
		if resp.StatusCode == expected {
			return resp, nil
		}
	}
	// Reject unexpected status codes as error
	if len(s.status) > 0 || resp.StatusCode >= http.StatusBadRequest {
		defer resp.Body.Close()
		data, err := io.ReadAll(resp.Body)
		if err != nil {
			return resp, errors.Errorf("Error status %d: %w", resp.StatusCode, err)
		}
		return resp, errors.Errorf("Error status %d: %s", resp.StatusCode, data)
	}
	return resp, nil
}

func ParseJSON[T any](r io.ReadCloser) (T, error) {
	defer r.Close()
	var data T
	dec := json.NewDecoder(r)
	if err := dec.Decode(&data); err != nil {
		return data, errors.Errorf("failed to parse response body: %w", err)
	}
	return data, nil
}
