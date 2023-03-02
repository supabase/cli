package utils

import (
	"context"
	"errors"
	"net"
	"net/http"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/mock"
	"github.com/supabase/cli/internal/testing/apitest"
	"gopkg.in/h2non/gock.v1"
)

const host = "api.supabase.io"

func TestLookupIP(t *testing.T) {
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
		ip, err := FallbackLookupIP(context.Background(), host)
		// Validate output
		assert.NoError(t, err)
		assert.ElementsMatch(t, []string{"127.0.0.1"}, ip)
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
		ip, err := FallbackLookupIP(context.Background(), "api.supabase.com")
		// Validate output
		assert.NoError(t, err)
		assert.ElementsMatch(t, []string{"2606:2800:220:1:248:1893:25c8:1946"}, ip)
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})

	t.Run("returns immediately if already resolved", func(t *testing.T) {
		// Run test
		ip, err := FallbackLookupIP(context.Background(), "127.0.0.1")
		// Validate output
		assert.NoError(t, err)
		assert.ElementsMatch(t, []string{"127.0.0.1"}, ip)
		assert.Empty(t, apitest.ListUnmatchedRequests())
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
		ip, err := FallbackLookupIP(context.Background(), host)
		// Validate output
		assert.ErrorContains(t, err, "network error")
		assert.Empty(t, ip)
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
		ip, err := FallbackLookupIP(context.Background(), host)
		// Validate output
		assert.ErrorContains(t, err, "status 503")
		assert.Empty(t, ip)
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
		ip, err := FallbackLookupIP(context.Background(), host)
		// Validate output
		assert.ErrorContains(t, err, "invalid character 'm' looking for beginning of value")
		assert.Empty(t, ip)
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
		ip, err := FallbackLookupIP(context.Background(), host)
		// Validate output
		assert.ErrorContains(t, err, "failed to locate valid IP for api.supabase.io; resolves to []utils.dnsAnswer(nil)")
		assert.Empty(t, ip)
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})
}

func TestResolveCNAME(t *testing.T) {
	t.Run("resolves CNAMEs with CloudFlare", func(t *testing.T) {
		defer gock.OffAll()
		gock.New("https://1.1.1.1").
			Get("/dns-query").
			MatchParam("name", host).
			MatchParam("type", "CNAME").
			MatchHeader("accept", "application/dns-json").
			Reply(http.StatusOK).
			JSON(&dnsResponse{Answer: []dnsAnswer{
				{Type: cnameType, Data: "foobarbaz.supabase.co"},
			}})
		// Run test
		cname, err := ResolveCNAME(context.Background(), host)
		// Validate output
		assert.Equal(t, "foobarbaz.supabase.co", cname)
		assert.Nil(t, err)
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})

	t.Run("missing CNAMEs return an error", func(t *testing.T) {
		defer gock.OffAll()
		gock.New("https://1.1.1.1").
			Get("/dns-query").
			MatchParam("name", host).
			MatchParam("type", "CNAME").
			MatchHeader("accept", "application/dns-json").
			Reply(http.StatusOK).
			JSON(&dnsResponse{Answer: []dnsAnswer{}})
		// Run test
		cname, err := ResolveCNAME(context.Background(), host)
		// Validate output
		assert.Empty(t, cname)
		assert.ErrorContains(t, err, "failed to locate appropriate CNAME record for api.supabase.io")
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})

	t.Run("missing CNAMEs return an error", func(t *testing.T) {
		defer gock.OffAll()
		gock.New("https://1.1.1.1").
			Get("/dns-query").
			MatchParam("name", host).
			MatchParam("type", "CNAME").
			MatchHeader("accept", "application/dns-json").
			Reply(http.StatusOK).
			JSON(&dnsResponse{Answer: []dnsAnswer{
				{Type: dnsIPv4Type, Data: "127.0.0.1"},
			}})
		// Run test
		cname, err := ResolveCNAME(context.Background(), host)
		// Validate output
		assert.Empty(t, cname)
		assert.ErrorContains(t, err, "failed to locate appropriate CNAME record for api.supabase.io")
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})
}

type MockDialer struct {
	mock.Mock
}

func (m *MockDialer) DialContext(ctx context.Context, network, address string) (net.Conn, error) {
	args := m.Called(ctx, network, address)
	if conn, ok := args.Get(0).(net.Conn); ok {
		return conn, args.Error(1)
	}
	return nil, args.Error(1)
}

func TestFallbackDNS(t *testing.T) {
	errNetwork := errors.New("network error")
	errDNS := &net.DNSError{
		IsTimeout: true,
	}

	t.Run("overrides DialContext with DoH", func(t *testing.T) {
		DNSResolver.Value = DNS_OVER_HTTPS
		// Setup mock dialer
		dialer := MockDialer{}
		dialer.On("DialContext", mock.Anything, mock.Anything, "127.0.0.1:80").
			Return(nil, errNetwork)
		wrapped := withFallbackDNS(dialer.DialContext)
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
		conn, err := wrapped(context.Background(), "udp", host+":80")
		// Check error
		assert.ErrorIs(t, err, errNetwork)
		assert.Nil(t, conn)
		dialer.AssertExpectations(t)
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})

	t.Run("native with DoH fallback", func(t *testing.T) {
		DNSResolver.Value = DNS_GO_NATIVE
		// Setup mock dialer
		dialer := MockDialer{}
		dialer.On("DialContext", mock.Anything, mock.Anything, host+":80").
			Return(nil, errDNS)
		dialer.On("DialContext", mock.Anything, mock.Anything, "127.0.0.1:80").
			Return(nil, nil)
		wrapped := withFallbackDNS(dialer.DialContext)
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
		conn, err := wrapped(context.Background(), "udp", host+":80")
		// Check error
		assert.NoError(t, err)
		assert.Nil(t, conn)
		dialer.AssertExpectations(t)
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})

	t.Run("throws error on malformed address", func(t *testing.T) {
		DNSResolver.Value = DNS_OVER_HTTPS
		// Setup mock dialer
		dialer := MockDialer{}
		wrapped := withFallbackDNS(dialer.DialContext)
		// Run test
		conn, err := wrapped(context.Background(), "udp", "bad?url")
		// Check error
		assert.ErrorContains(t, err, "missing port in address")
		assert.Nil(t, conn)
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})

	t.Run("throws error on fallback failure", func(t *testing.T) {
		DNSResolver.Value = DNS_GO_NATIVE
		// Setup mock dialer
		dialer := MockDialer{}
		dialer.On("DialContext", mock.Anything, mock.Anything, host+":80").
			Return(nil, errDNS)
		wrapped := withFallbackDNS(dialer.DialContext)
		// Setup http mock
		defer gock.OffAll()
		gock.New("https://1.1.1.1").
			Get("/dns-query").
			MatchParam("name", host).
			MatchHeader("accept", "application/dns-json").
			ReplyError(errNetwork)
		// Run test
		conn, err := wrapped(context.Background(), "udp", host+":80")
		// Check error
		assert.ErrorIs(t, err, errDNS)
		assert.Nil(t, conn)
		dialer.AssertExpectations(t)
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})
}
