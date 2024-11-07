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

func TestUpdateLocalApiConfig(t *testing.T) {
	server := "https://api.supabase.io"
	client, err := v1API.NewClientWithResponses(server)
	require.NoError(t, err)

	t.Run("updates local api config", func(t *testing.T) {
		updater := NewConfigUpdater(*client)
		// Setup mock server
		defer gock.Off()
		gock.New(server).
			Get("/v1/projects/test-project/config/postgrest").
			Reply(http.StatusOK).
			JSON(v1API.PostgrestConfigWithJWTSecretResponse{
				DbSchema:          "public,private,protected",
				DbExtraSearchPath: "extensions",
				MaxRows:           500,
			})

		// Run test
		err := updater.UpdateLocalApiConfig(context.Background(), "test-project", api{
			Enabled: true,
			Schemas: []string{"public"},
			MaxRows: 1000,
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
			Get("/v1/projects/test-project/config/postgrest").
			Reply(http.StatusOK).
			JSON(v1API.PostgrestConfigWithJWTSecretResponse{
				MaxRows: 1000,
			})

		// Run test
		err := updater.UpdateLocalApiConfig(context.Background(), "test-project", api{})

		// Check result
		assert.NoError(t, err)
		assert.True(t, gock.IsDone())
	})
}
