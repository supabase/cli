package fetcher

import (
	"net/http"
	"strings"
)

// NewServiceGateway returns a Fetcher for Supabase service-gateway calls (Kong,
// Storage, Auth, etc.). It deliberately omits http.Client.Timeout so streaming
// operations such as storage uploads are not capped under load. Connection
// setup is still bounded by the default transport's dial and TLS-handshake
// timeouts, and per-call deadlines should flow through the request context.
func NewServiceGateway(server, token string, overrides ...FetcherOption) *Fetcher {
	opts := append([]FetcherOption{
		WithHTTPClient(&http.Client{}),
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
