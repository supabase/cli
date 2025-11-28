package push

import (
	"context"
	"errors"
	"net/http"
	"testing"

	"github.com/h2non/gock"
	"github.com/spf13/afero"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"github.com/supabase/cli/internal/testing/apitest"
	"github.com/supabase/cli/internal/utils"
)

func TestPushConfig(t *testing.T) {
	project := apitest.RandomProjectRef()
	// Setup valid access token
	token := apitest.RandomAccessToken(t)
	t.Setenv("SUPABASE_ACCESS_TOKEN", string(token))

	t.Run("throws error on malformed config", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		require.NoError(t, utils.WriteFile(utils.ConfigPath, []byte("malformed"), fsys))
		// Run test
		err := Run(context.Background(), "", false, fsys)
		// Check error
		assert.ErrorContains(t, err, "toml: expected = after a key, but the document ends there")
	})

	t.Run("throws error on service unavailable", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		// Setup mock api
		defer gock.OffAll()
		gock.New(utils.DefaultApiHost).
			Get("/v1/projects/" + project + "/billing/addons").
			Reply(http.StatusServiceUnavailable)
		// Run test
		err := Run(context.Background(), project, false, fsys)
		// Check error
		assert.ErrorContains(t, err, "unexpected list addons status 503:")
	})
}

func TestCostMatrix(t *testing.T) {
	project := apitest.RandomProjectRef()
	// Setup valid access token
	token := apitest.RandomAccessToken(t)
	t.Setenv("SUPABASE_ACCESS_TOKEN", string(token))

	t.Run("fetches cost matrix", func(t *testing.T) {
		// Setup mock api
		defer gock.OffAll()
		gock.New(utils.DefaultApiHost).
			Get("/v1/projects/"+project+"/billing/addons").
			Reply(http.StatusOK).
			SetHeader("Content-Type", "application/json").
			BodyString(`{
				"available_addons":[{
					"name": "Advanced MFA - Phone",
					"type": "auth_mfa_phone",
					"variants": [{
						"id": "auth_mfa_phone_default",
						"name": "Advanced MFA - Phone",
						"price": {
						"amount": 0.1027,
						"description": "$75/month, then $10/month",
						"interval": "hourly",
						"type": "usage"
						}
					}]
				}, {
					"name": "Advanced MFA - WebAuthn",
					"type": "auth_mfa_web_authn",
					"variants": [{
						"id": "auth_mfa_web_authn_default",
						"name": "Advanced MFA - WebAuthn",
						"price": {
						"amount": 0.1027,
						"description": "$75/month, then $10/month",
						"interval": "hourly",
						"type": "usage"
						}
					}]
				}]
			}`)
		// Run test
		cost, err := getCostMatrix(context.Background(), project)
		// Check error
		assert.NoError(t, err)
		require.Len(t, cost, 2)
		assert.Equal(t, "Advanced MFA - Phone", cost["auth_mfa_phone"].Name)
		assert.Equal(t, "$75/month, then $10/month", cost["auth_mfa_phone"].Price)
		assert.Equal(t, "Advanced MFA - WebAuthn", cost["auth_mfa_web_authn"].Name)
		assert.Equal(t, "$75/month, then $10/month", cost["auth_mfa_web_authn"].Price)
	})

	t.Run("throws error on network error", func(t *testing.T) {
		errNetwork := errors.New("network error")
		// Setup mock api
		defer gock.OffAll()
		gock.New(utils.DefaultApiHost).
			Get("/v1/projects/" + project + "/billing/addons").
			ReplyError(errNetwork)
		// Run test
		cost, err := getCostMatrix(context.Background(), project)
		// Check error
		assert.ErrorIs(t, err, errNetwork)
		assert.Nil(t, cost)
	})
}
