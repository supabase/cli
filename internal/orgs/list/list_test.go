package list

import (
	"context"
	"errors"
	"net/http"
	"testing"

	"github.com/h2non/gock"
	"github.com/stretchr/testify/assert"
	"github.com/supabase/cli/internal/testing/apitest"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/pkg/api"
)

func TestOrganizationListCommand(t *testing.T) {
	t.Run("lists all organizations", func(t *testing.T) {
		// Setup valid access token
		token := apitest.RandomAccessToken(t)
		t.Setenv("SUPABASE_ACCESS_TOKEN", string(token))
		// Flush pending mocks after test execution
		defer gock.OffAll()
		gock.New(utils.DefaultApiHost).
			Get("/v1/organizations").
			Reply(http.StatusOK).
			JSON([]api.OrganizationResponseV1{
				{
					Id:   "combined-fuchsia-lion",
					Name: "Test Organization",
				},
			})
		// Run test
		_, err := Run(context.Background())
		assert.NoError(t, err)
		// Validate api
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})

	t.Run("throws error on network error", func(t *testing.T) {
		// Setup valid access token
		token := apitest.RandomAccessToken(t)
		t.Setenv("SUPABASE_ACCESS_TOKEN", string(token))
		// Flush pending mocks after test execution
		defer gock.OffAll()
		gock.New(utils.DefaultApiHost).
			Get("/v1/organizations").
			ReplyError(errors.New("network error"))
		// Run test
		_, err := Run(context.Background())
		assert.Error(t, err)
		// Validate api
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})

	t.Run("throws error on server unavailable", func(t *testing.T) {
		// Setup valid access token
		token := apitest.RandomAccessToken(t)
		t.Setenv("SUPABASE_ACCESS_TOKEN", string(token))
		// Flush pending mocks after test execution
		defer gock.OffAll()
		gock.New(utils.DefaultApiHost).
			Get("/v1/organizations").
			Reply(http.StatusServiceUnavailable).
			JSON(map[string]string{"message": "unavailable"})
		// Run test
		_, err := Run(context.Background())
		assert.Error(t, err)
		// Validate api
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})
}
