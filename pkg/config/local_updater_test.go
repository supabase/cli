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
	server := "http://localhost"
	client, err := v1API.NewClientWithResponses(server)
	require.NoError(t, err)
	t.Run("updates local api config", func(t *testing.T) {
		updater := NewConfigUpdater(*client)
		// Setup mock server
		defer gock.Off()
		gock.New(server).
			Get("/v1/projects/test-project/postgrest").
			Reply(http.StatusOK).
			JSON(v1API.PostgrestConfigWithJWTSecretResponse{
				DbSchema:          "public,private,protected",
				DbExtraSearchPath: "extensions",
				MaxRows:           500,
			})

		// Run test
		config := api{
			Enabled: true,
			Schemas: []string{"public"},
			MaxRows: 1000,
		}
		diff, err := updater.UpdateLocalApiConfig(context.Background(), "test-project", &config)

		// Check result
		assert.NoError(t, err)
		assert.NotNil(t, diff)
		assert.True(t, len(diff) > 0)
		assert.True(t, gock.IsDone())
		assert.Equal(t, []string{"public", "private", "protected"}, config.Schemas)
		assert.Equal(t, []string{"extensions"}, config.ExtraSearchPath)
		assert.Equal(t, uint(500), config.MaxRows)
	})

	t.Run("skips update if no diff", func(t *testing.T) {
		updater := NewConfigUpdater(*client)
		// Setup mock server
		defer gock.Off()
		gock.New(server).
			Get("/v1/projects/test-project/postgrest").
			Reply(http.StatusOK).
			JSON(v1API.PostgrestConfigWithJWTSecretResponse{
				DbSchema: "public",
				MaxRows:  1000,
			})

		// Run test
		config := api{
			Enabled: true,
			Schemas: []string{"public"},
			MaxRows: 1000,
		}
		diff, err := updater.UpdateLocalApiConfig(context.Background(), "test-project", &config)

		// Check result
		assert.NoError(t, err)
		assert.Nil(t, diff)
		assert.True(t, gock.IsDone())
		assert.Equal(t, []string{"public"}, config.Schemas)
		assert.Equal(t, uint(1000), config.MaxRows)
	})
}
