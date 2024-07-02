package cloudflare

import (
	"net/http"
	"time"

	"github.com/supabase/cli/pkg/fetcher"
)

type CloudflareAPI struct {
	*fetcher.Fetcher
}

func NewCloudflareAPI() CloudflareAPI {
	server := "https://1.1.1.1"
	client := &http.Client{
		Timeout: 10 * time.Second,
	}
	header := func(req *http.Request) {
		req.Header.Add("accept", "application/dns-json")
	}
	api := CloudflareAPI{Fetcher: fetcher.NewFetcher(
		server,
		fetcher.WithHTTPClient(client),
		fetcher.WithRequestEditor(header),
		fetcher.WithExpectedStatus(http.StatusOK),
	)}
	return api
}
