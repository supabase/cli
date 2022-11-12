package hostnames

import (
	"context"
	"net/http"
	"testing"

	"github.com/stretchr/testify/assert"
	"gopkg.in/h2non/gock.v1"
)

func TestVerifyCNAME(t *testing.T) {
	defer gock.OffAll()
	gock.New("https://1.1.1.1").
		Get("/dns-query").
		MatchParam("name", "hello.custom-domain.com").
		MatchParam("type", "CNAME").
		MatchHeader("accept", "application/dns-json").
		Reply(http.StatusOK).
		JSON(&map[string]interface{}{"Answer": []map[string]interface{}{
			{
				"Type": 5, "Data": "foobarbaz.supabase.co.",
			},
		}})
	err := VerifyCNAME(context.Background(), "foobarbaz", "hello.custom-domain.com")
	assert.Empty(t, err)
}

func TestVerifyCNAMEFailures(t *testing.T) {
	defer gock.OffAll()
	gock.New("https://1.1.1.1").
		Get("/dns-query").
		MatchParam("name", "hello.custom-domain.com").
		MatchParam("type", "CNAME").
		MatchHeader("accept", "application/dns-json").
		Reply(http.StatusOK).
		JSON(&map[string]interface{}{"Answer": []map[string]interface{}{
			{
				"Type": 28, "Data": "127.0.0.1",
			},
		}})
	err := VerifyCNAME(context.Background(), "foobarbaz", "hello.custom-domain.com")
	assert.ErrorContains(t, err, "expected custom hostname 'hello.custom-domain.com' to have a CNAME record pointing to your project at 'foobarbaz.supabase.co.', but it failed to resolve: failed to locate appropriate CNAME record for hello.custom-domain.com")
}
