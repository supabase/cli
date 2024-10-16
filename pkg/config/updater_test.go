package config

import (
	"context"
	"net/http"
	"testing"

	"github.com/h2non/gock"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	v1API "github.com/supabase/cli/pkg/api"
)

func TestUpdateApi(t *testing.T) {
	server := "http://localhost"
	client, err := v1API.NewClientWithResponses(server)
	require.NoError(t, err)

	t.Run("updates remote config", func(t *testing.T) {
		updater := NewConfigUpdater(*client)
		// Setup mock server
		defer gock.Off()
		gock.New(server).
			Get("/v1/projects/test-project/postgrest").
			Reply(http.StatusOK).
			JSON(v1API.PostgrestConfigWithJWTSecretResponse{})
		gock.New(server).
			Patch("/v1/projects/test-project/postgrest").
			Reply(http.StatusOK).
			JSON(v1API.PostgrestConfigWithJWTSecretResponse{
				DbSchema:          "public,graphql_public",
				DbExtraSearchPath: "public,extensions",
				MaxRows:           1000,
			})
		// Run test
		err := updater.UpdateApiConfig(context.Background(), "test-project", api{
			Enabled:         true,
			Schemas:         []string{"public", "graphql_public"},
			ExtraSearchPath: []string{"public", "extensions"},
			MaxRows:         1000,
		})
		// Check result
		assert.NoError(t, err)
		assert.True(t, gock.IsDone())
	})

	t.Run("skips update if no diff", func(t *testing.T) {
		updater := NewConfigUpdater(*client)
		// Setup mock server
		defer gock.Off()
		gock.New(server).
			Get("/v1/projects/test-project/postgrest").
			Reply(http.StatusOK).
			JSON(v1API.PostgrestConfigWithJWTSecretResponse{
				DbSchema:          "",
				DbExtraSearchPath: "public,extensions",
				MaxRows:           1000,
			})
		// Run test
		err := updater.UpdateApiConfig(context.Background(), "test-project", api{})
		// Check result
		assert.NoError(t, err)
		assert.True(t, gock.IsDone())
	})
}
