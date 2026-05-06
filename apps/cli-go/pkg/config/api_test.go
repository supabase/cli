package config

import (
	"testing"

	"github.com/stretchr/testify/assert"
	v1API "github.com/supabase/cli/pkg/api"
)

func TestApiToUpdatePostgrestConfigBody(t *testing.T) {
	t.Run("converts all fields correctly", func(t *testing.T) {
		api := &api{
			Enabled:         true,
			Schemas:         []string{"public", "private"},
			ExtraSearchPath: []string{"extensions", "public"},
			MaxRows:         1000,
		}

		body := api.ToUpdatePostgrestConfigBody()

		assert.Equal(t, "public,private", *body.DbSchema)
		assert.Equal(t, "extensions,public", *body.DbExtraSearchPath)
		assert.Equal(t, 1000, *body.MaxRows)
	})

	t.Run("handles empty fields", func(t *testing.T) {
		api := &api{}

		body := api.ToUpdatePostgrestConfigBody()

		// remote api will be false by default, leading to an empty schema on api side
		assert.Equal(t, "", *body.DbSchema)
	})
}

func TestApiDiff(t *testing.T) {
	t.Run("detects differences", func(t *testing.T) {
		api := &api{
			Enabled:         true,
			Schemas:         []string{"public", "private"},
			ExtraSearchPath: []string{"extensions", "public"},
			MaxRows:         1000,
		}

		remoteConfig := v1API.PostgrestConfigWithJWTSecretResponse{
			DbSchema:          "public",
			DbExtraSearchPath: "public",
			MaxRows:           500,
		}

		diff, err := api.DiffWithRemote(remoteConfig)
		assert.NoError(t, err)

		assertSnapshotEqual(t, diff)
	})

	t.Run("handles no differences", func(t *testing.T) {
		api := &api{
			Enabled:         true,
			Schemas:         []string{"public"},
			ExtraSearchPath: []string{"public"},
			MaxRows:         500,
		}

		remoteConfig := v1API.PostgrestConfigWithJWTSecretResponse{
			DbSchema:          "public",
			DbExtraSearchPath: "public",
			MaxRows:           500,
		}

		diff, err := api.DiffWithRemote(remoteConfig)
		assert.NoError(t, err)

		assert.Empty(t, diff)
	})

	t.Run("handles multiple schemas and search paths with spaces", func(t *testing.T) {
		api := &api{
			Enabled:         true,
			Schemas:         []string{"public", "private"},
			ExtraSearchPath: []string{"extensions", "public"},
			MaxRows:         500,
		}

		remoteConfig := v1API.PostgrestConfigWithJWTSecretResponse{
			DbSchema:          "public, private",
			DbExtraSearchPath: "extensions, public",
			MaxRows:           500,
		}

		diff, err := api.DiffWithRemote(remoteConfig)
		assert.NoError(t, err)

		assert.Empty(t, diff)
	})

	t.Run("handles api disabled on remote side", func(t *testing.T) {
		api := &api{
			Enabled:         true,
			Schemas:         []string{"public", "private"},
			ExtraSearchPath: []string{"extensions", "public"},
			MaxRows:         500,
		}

		remoteConfig := v1API.PostgrestConfigWithJWTSecretResponse{
			DbSchema:          "",
			DbExtraSearchPath: "",
			MaxRows:           0,
		}

		diff, err := api.DiffWithRemote(remoteConfig)
		assert.NoError(t, err)

		assertSnapshotEqual(t, diff)
	})

	t.Run("handles api disabled on local side", func(t *testing.T) {
		api := &api{
			Enabled:         false,
			Schemas:         []string{"public"},
			ExtraSearchPath: []string{"public"},
			MaxRows:         500,
		}

		remoteConfig := v1API.PostgrestConfigWithJWTSecretResponse{
			DbSchema:          "public",
			DbExtraSearchPath: "public",
			MaxRows:           500,
		}

		diff, err := api.DiffWithRemote(remoteConfig)
		assert.NoError(t, err)

		assertSnapshotEqual(t, diff)
	})
}
