package list

import (
	"context"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/supabase/cli/internal/testing/apitest"
	"github.com/supabase/cli/internal/utils"
	"gopkg.in/h2non/gock.v1"
)

func TestSSOProvidersListCommand(t *testing.T) {
	t.Run("lists all providers", func(t *testing.T) {
		// Setup valid access token
		token := apitest.RandomAccessToken(t)
		t.Setenv("SUPABASE_ACCESS_TOKEN", string(token))

		// Flush pending mocks after test execution
		defer gock.OffAll()

		projectRef := "abcdefghijklmnopqrst"

		gock.New(utils.DefaultApiHost).
			Get("/v1/projects/" + projectRef + "/config/auth/sso/providers").
			Reply(200).
			JSON(map[string]any{
				"items": []map[string]any{
					{
						"id":         "0b0d48f6-878b-4190-88d7-2ca33ed800bc",
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
						"domains": []map[string]any{
							{
								"id":         "9484591c-a203-4500-bea7-d0aaa845e2f5",
								"domain":     "example.com",
								"created_at": "2023-03-28T13:50:14.464Z",
								"updated_at": "2023-03-28T13:50:14.464Z",
							},
						},
					},
				},
			})

		// Run test
		assert.NoError(t, Run(context.Background(), projectRef, utils.OutputPretty))
		// Validate api
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})

	t.Run("list providers with disabled SAML", func(t *testing.T) {
		// Setup valid access token
		token := apitest.RandomAccessToken(t)
		t.Setenv("SUPABASE_ACCESS_TOKEN", string(token))

		// Flush pending mocks after test execution
		defer gock.OffAll()

		projectRef := "abcdefghijklmnopqrst"

		gock.New(utils.DefaultApiHost).
			Get("/v1/projects/" + projectRef + "/config/auth/sso/providers").
			Reply(404).
			JSON(map[string]string{})

		err := Run(context.Background(), projectRef, utils.OutputPretty)

		// Run test
		assert.Error(t, err)
		assert.Equal(t, err.Error(), "Looks like SAML 2.0 support is not enabled for this project. Please use the dashboard to enable it.")

		// Validate api
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})
}
