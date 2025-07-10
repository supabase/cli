package config

import (
	"context"
	"net/http"
	"testing"

	"github.com/h2non/gock"
	"github.com/oapi-codegen/nullable"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	v1API "github.com/supabase/cli/pkg/api"
	"github.com/supabase/cli/pkg/cast"
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

func TestUpdateDbConfig(t *testing.T) {
	server := "http://localhost"
	client, err := v1API.NewClientWithResponses(server)
	require.NoError(t, err)

	t.Run("updates remote DB config", func(t *testing.T) {
		updater := NewConfigUpdater(*client)
		// Setup mock server
		defer gock.Off()
		gock.New(server).
			Get("/v1/projects/test-project/config/database").
			Reply(http.StatusOK).
			JSON(v1API.PostgresConfigResponse{})
		gock.New(server).
			Put("/v1/projects/test-project/config/database").
			Reply(http.StatusOK).
			JSON(v1API.PostgresConfigResponse{
				MaxConnections: cast.Ptr(cast.UintToInt(100)),
			})
		// Run test
		err := updater.UpdateDbConfig(context.Background(), "test-project", db{
			Settings: settings{
				MaxConnections: cast.Ptr(cast.IntToUint(100)),
			},
		})
		// Check result
		assert.NoError(t, err)
		assert.True(t, gock.IsDone())
	})

	t.Run("skips update if no diff in DB config", func(t *testing.T) {
		updater := NewConfigUpdater(*client)
		// Setup mock server
		defer gock.Off()
		gock.New(server).
			Get("/v1/projects/test-project/config/database").
			Reply(http.StatusOK).
			JSON(v1API.PostgresConfigResponse{
				MaxConnections: cast.Ptr(cast.UintToInt(100)),
			})
		// Run test
		err := updater.UpdateDbConfig(context.Background(), "test-project", db{
			Settings: settings{
				MaxConnections: cast.Ptr(cast.IntToUint(100)),
			},
		})
		// Check result
		assert.NoError(t, err)
		assert.True(t, gock.IsDone())
	})
}

func TestUpdateExperimentalConfig(t *testing.T) {
	server := "http://localhost"
	client, err := v1API.NewClientWithResponses(server)
	require.NoError(t, err)

	t.Run("enables webhooks", func(t *testing.T) {
		updater := NewConfigUpdater(*client)
		// Setup mock server
		defer gock.Off()
		gock.New(server).
			Post("/v1/projects/test-project/database/webhooks/enable").
			Reply(http.StatusOK).
			JSON(map[string]interface{}{})
		// Run test
		err := updater.UpdateExperimentalConfig(context.Background(), "test-project", experimental{
			Webhooks: &webhooks{
				Enabled: true,
			},
		})
		// Check result
		assert.NoError(t, err)
		assert.True(t, gock.IsDone())
	})

	t.Run("skips update if webhooks not enabled", func(t *testing.T) {
		updater := NewConfigUpdater(*client)
		// Run test
		err := updater.UpdateExperimentalConfig(context.Background(), "test-project", experimental{
			Webhooks: &webhooks{
				Enabled: false,
			},
		})
		// Check result
		assert.NoError(t, err)
		assert.True(t, gock.IsDone())
	})
}

func TestUpdateAuthConfig(t *testing.T) {
	server := "http://localhost"
	client, err := v1API.NewClientWithResponses(server)
	require.NoError(t, err)

	t.Run("updates remote Auth config", func(t *testing.T) {
		updater := NewConfigUpdater(*client)
		// Setup mock server
		defer gock.Off()
		gock.New(server).
			Get("/v1/projects/test-project/config/auth").
			Reply(http.StatusOK).
			JSON(v1API.AuthConfigResponse{
				SiteUrl: nullable.NewNullableWithValue("http://localhost:3000"),
			})
		gock.New(server).
			Patch("/v1/projects/test-project/config/auth").
			Reply(http.StatusOK)
		// Run test
		err := updater.UpdateAuthConfig(context.Background(), "test-project", auth{Enabled: true})
		// Check result
		assert.NoError(t, err)
		assert.True(t, gock.IsDone())
	})

	t.Run("skips update if no diff in Auth config", func(t *testing.T) {
		updater := NewConfigUpdater(*client)
		// Setup mock server
		defer gock.Off()
		gock.New(server).
			Get("/v1/projects/test-project/config/auth").
			Reply(http.StatusOK).
			JSON(v1API.AuthConfigResponse{})
		// Run test
		err := updater.UpdateAuthConfig(context.Background(), "test-project", auth{
			Enabled:                true,
			EnableSignup:           true,
			AdditionalRedirectUrls: []string{},
			Email:                  email{EnableConfirmations: true},
			Sms:                    sms{TestOTP: map[string]string{}},
		})
		// Check result
		assert.NoError(t, err)
		assert.True(t, gock.IsDone())
	})

	t.Run("skips update if disabled locally", func(t *testing.T) {
		updater := NewConfigUpdater(*client)
		// Run test
		err := updater.UpdateAuthConfig(context.Background(), "test-project", auth{})
		// Check result
		assert.NoError(t, err)
	})
}

func TestUpdateStorageConfig(t *testing.T) {
	server := "http://localhost"
	client, err := v1API.NewClientWithResponses(server)
	require.NoError(t, err)

	t.Run("updates remote Storage config", func(t *testing.T) {
		updater := NewConfigUpdater(*client)
		// Setup mock server
		defer gock.Off()
		mockStorage := v1API.StorageConfigResponse{
			FileSizeLimit: 100,
			Features: struct {
				IcebergCatalog *struct {
					Enabled bool `json:"enabled"`
				} `json:"icebergCatalog,omitempty"`
				ImageTransformation struct {
					Enabled bool `json:"enabled"`
				} `json:"imageTransformation"`
				S3Protocol struct {
					Enabled bool `json:"enabled"`
				} `json:"s3Protocol"`
			}{},
		}
		mockStorage.Features.ImageTransformation.Enabled = true
		gock.New(server).
			Get("/v1/projects/test-project/config/storage").
			Reply(http.StatusOK).
			JSON(mockStorage)
		gock.New(server).
			Patch("/v1/projects/test-project/config/storage").
			Reply(http.StatusOK)
		// Run test
		err := updater.UpdateStorageConfig(context.Background(), "test-project", storage{Enabled: true})
		// Check result
		assert.NoError(t, err)
		assert.True(t, gock.IsDone())
	})

	t.Run("skips update if no diff in Storage config", func(t *testing.T) {
		updater := NewConfigUpdater(*client)
		// Setup mock server
		defer gock.Off()
		gock.New(server).
			Get("/v1/projects/test-project/config/storage").
			Reply(http.StatusOK).
			JSON(v1API.StorageConfigResponse{})
		// Run test
		err := updater.UpdateStorageConfig(context.Background(), "test-project", storage{Enabled: true})
		// Check result
		assert.NoError(t, err)
		assert.True(t, gock.IsDone())
	})

	t.Run("skips update if disabled locally", func(t *testing.T) {
		updater := NewConfigUpdater(*client)
		// Run test
		err := updater.UpdateStorageConfig(context.Background(), "test-project", storage{})
		// Check result
		assert.NoError(t, err)
	})
}

func TestUpdateRemoteConfig(t *testing.T) {
	server := "http://localhost"
	client, err := v1API.NewClientWithResponses(server)
	require.NoError(t, err)

	t.Run("updates all configs", func(t *testing.T) {
		updater := NewConfigUpdater(*client)
		// Setup mock server
		defer gock.Off()
		// API config
		gock.New(server).
			Get("/v1/projects/test-project/postgrest").
			Reply(http.StatusOK).
			JSON(v1API.PostgrestConfigWithJWTSecretResponse{})
		gock.New(server).
			Patch("/v1/projects/test-project/postgrest").
			Reply(http.StatusOK).
			JSON(v1API.PostgrestConfigWithJWTSecretResponse{
				DbSchema: "public",
				MaxRows:  1000,
			})
		// DB config
		gock.New(server).
			Get("/v1/projects/test-project/config/database").
			Reply(http.StatusOK).
			JSON(v1API.PostgresConfigResponse{})
		gock.New(server).
			Put("/v1/projects/test-project/config/database").
			Reply(http.StatusOK).
			JSON(v1API.PostgresConfigResponse{
				MaxConnections: cast.Ptr(cast.UintToInt(100)),
			})
		// Auth config
		gock.New(server).
			Get("/v1/projects/test-project/config/auth").
			Reply(http.StatusOK).
			JSON(v1API.AuthConfigResponse{})
		gock.New(server).
			Patch("/v1/projects/test-project/config/auth").
			Reply(http.StatusOK)
		// Storage config
		gock.New(server).
			Get("/v1/projects/test-project/config/storage").
			Reply(http.StatusOK).
			JSON(v1API.StorageConfigResponse{})
		gock.New(server).
			Patch("/v1/projects/test-project/config/storage").
			Reply(http.StatusOK)
		// Experimental config
		gock.New(server).
			Post("/v1/projects/test-project/database/webhooks/enable").
			Reply(http.StatusOK).
			JSON(map[string]interface{}{})
		// Run test
		err := updater.UpdateRemoteConfig(context.Background(), baseConfig{
			ProjectId: "test-project",
			Api: api{
				Enabled: true,
				Schemas: []string{"public", "private"},
				MaxRows: 1000,
			},
			Db: db{
				Settings: settings{
					MaxConnections: cast.Ptr(cast.IntToUint(100)),
				},
			},
			Auth: auth{
				Enabled: true,
				SiteUrl: "http://localhost:3000",
			},
			Storage: storage{
				Enabled:       true,
				FileSizeLimit: 100,
				ImageTransformation: &imageTransformation{
					Enabled: true,
				},
			},
			Experimental: experimental{
				Webhooks: &webhooks{
					Enabled: true,
				},
			},
		})
		// Check result
		assert.NoError(t, err)
		assert.True(t, gock.IsDone())
	})
}
