package hostnames

import (
	"bytes"
	"context"
	"net/http"
	"testing"

	"github.com/h2non/gock"
	"github.com/stretchr/testify/assert"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/pkg/api"
)

func TestVerifyCNAME(t *testing.T) {
	utils.CurrentProfile.ProjectHost = "supabase.co"
	defer gock.OffAll()
	gock.New("https://1.1.1.1").
		Get("/dns-query").
		MatchParam("name", "hello.custom-domain.com").
		MatchParam("type", "5").
		MatchHeader("accept", "application/dns-json").
		Reply(http.StatusOK).
		JSON(&map[string]any{"Answer": []map[string]any{
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
		MatchParam("type", "5").
		MatchHeader("accept", "application/dns-json").
		Reply(http.StatusOK).
		JSON(&map[string]any{"Answer": []map[string]any{
			{
				"Type": 28, "Data": "127.0.0.1",
			},
		}})
	err := VerifyCNAME(context.Background(), "foobarbaz", "hello.custom-domain.com")
	assert.ErrorContains(t, err, "failed to locate appropriate CNAME record for hello.custom-domain.com")
}

func TestPrintStatus(t *testing.T) {
	t.Run("initialising hostname message", func(t *testing.T) {
		data := api.UpdateCustomHostnameResponse{Status: api.N2Initiated}
		data.Data.Result.Ssl.Status = "initializing"
		var buf bytes.Buffer
		PrintStatus(&data, &buf)
		assert.Equal(t, "Custom hostname setup is being initialized; please request re-verification in a few seconds.\n", buf.String())
	})

	t.Run("validation records message", func(t *testing.T) {
		data := api.UpdateCustomHostnameResponse{Status: api.N2Initiated}
		data.Data.Result.Ssl.ValidationRecords = []struct {
			TxtName  string `json:"txt_name"`
			TxtValue string `json:"txt_value"`
		}{{
			TxtName:  "_pki-validation",
			TxtValue: "f3k9d8s7h2l1m4n6p0q5r",
		}}
		var buf bytes.Buffer
		PrintStatus(&data, &buf)
		assert.Equal(t, `Custom hostname verification in-progress; please configure the appropriate DNS entries and request re-verification.
Required outstanding validation records:
	_pki-validation TXT -> f3k9d8s7h2l1m4n6p0q5r`, buf.String())
	})

	t.Run("validation error message", func(t *testing.T) {
		data := api.UpdateCustomHostnameResponse{Status: api.N2Initiated}
		data.Data.Result.Ssl.ValidationErrors = &[]struct {
			Message string `json:"message"`
		}{{
			Message: "self signed cert",
		}}
		var buf bytes.Buffer
		PrintStatus(&data, &buf)
		assert.Equal(t, `SSL validation errors: 
	- self signed cert
`, buf.String())
	})

	t.Run("validation caa error message", func(t *testing.T) {
		data := api.UpdateCustomHostnameResponse{Status: api.N2Initiated}
		data.Data.Result.Ssl.ValidationErrors = &[]struct {
			Message string `json:"message"`
		}{{
			Message: "caa_error",
		}}
		var buf bytes.Buffer
		PrintStatus(&data, &buf)
		assert.Equal(t, "CAA mismatch; please remove any existing CAA records on your domain, or add one for \"digicert.com\"\n", buf.String())
	})
}
