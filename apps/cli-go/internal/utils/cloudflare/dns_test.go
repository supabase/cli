package cloudflare

import (
	"context"
	"net/http"
	"testing"

	"github.com/h2non/gock"
	"github.com/stretchr/testify/assert"
	"github.com/supabase/cli/internal/testing/apitest"
)

func TestDNSQuery(t *testing.T) {
	t.Run("successfully queries A records", func(t *testing.T) {
		api := NewCloudflareAPI()
		defer gock.OffAll()
		gock.New("https://1.1.1.1").
			Get("/dns-query").
			MatchParam("name", "example.com").
			MatchHeader("accept", "application/dns-json").
			Reply(http.StatusOK).
			JSON(DNSResponse{
				Answer: []DNSAnswer{
					{
						Name: "example.com",
						Type: TypeA,
						Ttl:  300,
						Data: "93.184.216.34",
					},
				},
			})

		resp, err := api.DNSQuery(context.Background(), DNSParams{
			Name: "example.com",
		})

		assert.NoError(t, err)
		assert.Len(t, resp.Answer, 1)
		assert.Equal(t, "93.184.216.34", resp.Answer[0].Data)
		assert.Equal(t, TypeA, resp.Answer[0].Type)
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})

	t.Run("successfully queries specific DNS type", func(t *testing.T) {
		api := NewCloudflareAPI()
		dnsType := TypeCNAME
		defer gock.OffAll()
		gock.New("https://1.1.1.1").
			Get("/dns-query").
			MatchParam("name", "www.example.com").
			MatchParam("type", "5"). // TypeCNAME = 5
			MatchHeader("accept", "application/dns-json").
			Reply(http.StatusOK).
			JSON(DNSResponse{
				Answer: []DNSAnswer{
					{
						Name: "www.example.com",
						Type: TypeCNAME,
						Ttl:  3600,
						Data: "example.com",
					},
				},
			})

		resp, err := api.DNSQuery(context.Background(), DNSParams{
			Name: "www.example.com",
			Type: &dnsType,
		})

		assert.NoError(t, err)
		assert.Len(t, resp.Answer, 1)
		assert.Equal(t, "example.com", resp.Answer[0].Data)
		assert.Equal(t, TypeCNAME, resp.Answer[0].Type)
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})

	t.Run("handles network error", func(t *testing.T) {
		api := NewCloudflareAPI()
		defer gock.OffAll()
		gock.New("https://1.1.1.1").
			Get("/dns-query").
			MatchParam("name", "example.com").
			ReplyError(gock.ErrCannotMatch)

		resp, err := api.DNSQuery(context.Background(), DNSParams{
			Name: "example.com",
		})

		assert.Error(t, err)
		assert.Empty(t, resp.Answer)
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})

	t.Run("handles service unavailable", func(t *testing.T) {
		api := NewCloudflareAPI()
		defer gock.OffAll()
		gock.New("https://1.1.1.1").
			Get("/dns-query").
			MatchParam("name", "example.com").
			Reply(http.StatusServiceUnavailable)

		resp, err := api.DNSQuery(context.Background(), DNSParams{
			Name: "example.com",
		})

		assert.ErrorContains(t, err, "status 503")
		assert.Empty(t, resp.Answer)
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})

	t.Run("handles malformed response", func(t *testing.T) {
		api := NewCloudflareAPI()
		defer gock.OffAll()
		gock.New("https://1.1.1.1").
			Get("/dns-query").
			MatchParam("name", "example.com").
			Reply(http.StatusOK).
			JSON("invalid json")

		resp, err := api.DNSQuery(context.Background(), DNSParams{
			Name: "example.com",
		})

		assert.ErrorContains(t, err, "failed to parse")
		assert.Empty(t, resp.Answer)
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})
}
