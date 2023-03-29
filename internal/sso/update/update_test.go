package update

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/supabase/cli/internal/testing/apitest"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/pkg/api"
	"gopkg.in/h2non/gock.v1"
)

func response(providerId string, domains []string) map[string]any {
	resp := map[string]any{
		"id":         providerId,
		"created_at": "2023-03-28T13:50:14.464Z",
		"updated_at": "2023-03-28T13:50:14.464Z",
		"saml": map[string]any{
			"id":           "8682fcf4-4056-455c-bd93-f33295604929",
			"metadata_url": "https://example.com",
			"metadata_xml": "<?xml version=\"2.0\"?>",
			"entity_id":    "https://example.com",
			"attribute_mapping": map[string]any{
				"keys": map[string]any{
					"a": map[string]any{
						"name": "xyz",
						"names": []string{
							"x",
							"y",
							"z",
						},
						"default": 3,
					},
				},
			},
			"created_at": "2023-03-28T13:50:14.464Z",
			"updated_at": "2023-03-28T13:50:14.464Z",
		},
		"domains": []map[string]any{},
	}

	for _, domain := range domains {
		respDomains := resp["domains"].([]map[string]any)
		resp["domains"] = append(respDomains, map[string]any{
			"id":         "9484591c-a203-4500-bea7-d0aaa845e2f5",
			"domain":     domain,
			"created_at": "2023-03-28T13:50:14.464Z",
			"updated_at": "2023-03-28T13:50:14.464Z",
		})
	}

	return resp
}

func TestSSOProvidersUpdateCommand(t *testing.T) {
	t.Run("update provider", func(t *testing.T) {
		// Setup valid access token
		token := apitest.RandomAccessToken(t)
		t.Setenv("SUPABASE_ACCESS_TOKEN", string(token))

		// Flush pending mocks after test execution
		defer gock.OffAll()

		projectRef := "abcdefghijklmnopqrst"
		providerId := "0b0d48f6-878b-4190-88d7-2ca33ed800bc"

		gock.New(utils.DefaultApiHost).
			Get("/v1/projects/" + projectRef + "/config/auth/sso/providers/" + providerId).
			Reply(200).
			JSON(response(providerId, []string{"example.com"}))

		gock.New(utils.DefaultApiHost).
			Put("/v1/projects/" + projectRef + "/config/auth/sso/providers/" + providerId).
			Reply(200).
			JSON(response(providerId, []string{"new-domain.com"}))

		observed := 0
		gock.Observe(func(r *http.Request, mock gock.Mock) {
			if r.Method != http.MethodPut {
				return
			}
			observed += 1

			var body api.UpdateProviderByIdJSONRequestBody
			assert.NoError(t, json.NewDecoder(r.Body).Decode(&body))

			assert.NotNil(t, body.Domains)
			assert.Equal(t, 1, len(*body.Domains))
			assert.Equal(t, "new-domain.com", (*body.Domains)[0])
		})

		// Run test
		assert.NoError(t, Run(context.Background(), RunParams{
			ProjectRef: projectRef,
			ProviderID: providerId,
			Format:     utils.OutputPretty,

			Domains: []string{
				"new-domain.com",
			},
		}))
		// Validate api
		assert.Empty(t, apitest.ListUnmatchedRequests())
		assert.Equal(t, 1, observed)
	})

	t.Run("update provider with --add-domains and --remove-domains", func(t *testing.T) {
		// Setup valid access token
		token := apitest.RandomAccessToken(t)
		t.Setenv("SUPABASE_ACCESS_TOKEN", string(token))

		// Flush pending mocks after test execution
		defer gock.OffAll()

		projectRef := "abcdefghijklmnopqrst"
		providerId := "0b0d48f6-878b-4190-88d7-2ca33ed800bc"

		gock.New(utils.DefaultApiHost).
			Get("/v1/projects/" + projectRef + "/config/auth/sso/providers/" + providerId).
			Reply(200).
			JSON(response(providerId, []string{"example.com"}))

		gock.New(utils.DefaultApiHost).
			Put("/v1/projects/" + projectRef + "/config/auth/sso/providers/" + providerId).
			Reply(200).
			JSON(response(providerId, []string{"new-domain.com"}))

		observed := 0
		gock.Observe(func(r *http.Request, mock gock.Mock) {
			if r.Method != http.MethodPut {
				return
			}
			observed += 1

			var body api.UpdateProviderByIdJSONRequestBody
			assert.NoError(t, json.NewDecoder(r.Body).Decode(&body))

			assert.NotNil(t, body.Domains)
			assert.Equal(t, 1, len(*body.Domains))
			assert.Equal(t, "new-domain.com", (*body.Domains)[0])
		})

		// Run test
		assert.NoError(t, Run(context.Background(), RunParams{
			ProjectRef: projectRef,
			ProviderID: providerId,
			Format:     utils.OutputPretty,

			AddDomains: []string{
				"new-domain.com",
			},
			RemoveDomains: []string{
				"example.com",
			},
		}))
		// Validate api
		assert.Empty(t, apitest.ListUnmatchedRequests())
		assert.Equal(t, 1, observed)

	})

	t.Run("update provider that does not exist", func(t *testing.T) {
		// Setup valid access token
		token := apitest.RandomAccessToken(t)
		t.Setenv("SUPABASE_ACCESS_TOKEN", string(token))

		// Flush pending mocks after test execution
		defer gock.OffAll()

		projectRef := "abcdefghijklmnopqrst"
		providerId := "0b0d48f6-878b-4190-88d7-2ca33ed800bc"

		gock.New(utils.DefaultApiHost).
			Get("/v1/projects/" + projectRef + "/config/auth/sso/providers/" + providerId).
			Reply(404).
			JSON(map[string]string{})

		err := Run(context.Background(), RunParams{
			ProjectRef: projectRef,
			ProviderID: providerId,
			Format:     utils.OutputPretty,
		})

		// Run test
		assert.Error(t, err)
		assert.Equal(t, err.Error(), fmt.Sprintf("An identity provider with ID %q could not be found.", providerId))

		// Validate api
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})
}
