package utils

import (
	"context"
	"errors"
	"net/http"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/supabase/cli/internal/testing/apitest"
	"gopkg.in/h2non/gock.v1"
)

func TestFallbackDNS(t *testing.T) {
	const host = "api.supabase.io"

	t.Run("resolves IPv4 with CloudFlare", func(t *testing.T) {
		// Setup http mock
		defer gock.OffAll()
		gock.New("https://1.1.1.1").
			Get("/dns-query").
			MatchParam("name", host).
			MatchHeader("accept", "application/dns-json").
			Reply(http.StatusOK).
			JSON(&dnsResponse{Answer: []dnsAnswer{
				{Type: dnsIPv4Type, Data: "127.0.0.1"},
			}})
		// Run test
		ip := fallbackLookupIP(context.Background(), host+":443")
		// Validate output
		assert.Equal(t, "127.0.0.1:443", ip)
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})

	t.Run("resolves IPv6 recursively", func(t *testing.T) {
		// Setup http mock
		defer gock.OffAll()
		gock.New("https://1.1.1.1").
			Get("/dns-query").
			MatchParam("name", "api.supabase.com").
			MatchHeader("accept", "application/dns-json").
			Reply(http.StatusOK).
			JSON(&dnsResponse{Answer: []dnsAnswer{
				{Type: 5, Data: "supabase-api.fly.dev."},
				{Type: dnsIPv6Type, Data: "2606:2800:220:1:248:1893:25c8:1946"},
			}})
		// Run test
		ip := fallbackLookupIP(context.Background(), "api.supabase.com:443")
		// Validate output
		assert.Equal(t, "[2606:2800:220:1:248:1893:25c8:1946]:443", ip)
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})

	t.Run("empty on malformed address", func(t *testing.T) {
		assert.Equal(t, "", fallbackLookupIP(context.Background(), "bad?url"))
	})

	t.Run("empty on network failure", func(t *testing.T) {
		// Setup http mock
		defer gock.OffAll()
		gock.New("https://1.1.1.1").
			Get("/dns-query").
			MatchParam("name", host).
			MatchHeader("accept", "application/dns-json").
			ReplyError(errors.New("network error"))
		// Run test
		ip := fallbackLookupIP(context.Background(), host+":443")
		// Validate output
		assert.Equal(t, "", ip)
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})

	t.Run("empty on service unavailable", func(t *testing.T) {
		// Setup http mock
		defer gock.OffAll()
		gock.New("https://1.1.1.1").
			Get("/dns-query").
			MatchParam("name", host).
			MatchHeader("accept", "application/dns-json").
			Reply(http.StatusServiceUnavailable)
		// Run test
		ip := fallbackLookupIP(context.Background(), host+":443")
		// Validate output
		assert.Equal(t, "", ip)
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})

	t.Run("empty on malformed json", func(t *testing.T) {
		// Setup http mock
		defer gock.OffAll()
		gock.New("https://1.1.1.1").
			Get("/dns-query").
			MatchParam("name", host).
			MatchHeader("accept", "application/dns-json").
			Reply(http.StatusOK).
			JSON("malformed")
		// Run test
		ip := fallbackLookupIP(context.Background(), host+":443")
		// Validate output
		assert.Equal(t, "", ip)
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})

	t.Run("empty on no answer", func(t *testing.T) {
		// Setup http mock
		defer gock.OffAll()
		gock.New("https://1.1.1.1").
			Get("/dns-query").
			MatchParam("name", host).
			MatchHeader("accept", "application/dns-json").
			Reply(http.StatusOK).
			JSON(&dnsResponse{})
		// Run test
		ip := fallbackLookupIP(context.Background(), host+":443")
		// Validate output
		assert.Equal(t, "", ip)
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})
}
