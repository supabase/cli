package fetcher

import (
	"net/http"
	"strings"
	"time"
)

func NewServiceGateway(server, token string, overrides ...FetcherOption) *Fetcher {
	opts := append([]FetcherOption{
		WithHTTPClient(&http.Client{
			Timeout: 10 * time.Second,
		}),
		withAuthToken(token),
		WithExpectedStatus(http.StatusOK),
	}, overrides...)
	return NewFetcher(server, opts...)
}

func withAuthToken(token string) FetcherOption {
	if strings.HasPrefix(token, "sb_") {
		header := func(req *http.Request) {
			req.Header.Add("apikey", token)
		}
		return WithRequestEditor(header)
	}
	header := func(req *http.Request) {
		req.Header.Add("apikey", token)
		req.Header.Add("Authorization", "Bearer "+token)
	}
	return WithRequestEditor(header)
}
