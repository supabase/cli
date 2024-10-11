package config

import (
	"testing"

	"github.com/stretchr/testify/assert"
	v1API "github.com/supabase/cli/pkg/api"
)

func TestApiToUpdatePostgrestConfigBody(t *testing.T) {
	t.Run("converts all fields correctly", func(t *testing.T) {
		api := &RemoteApi{
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
		api := &RemoteApi{}

		body := api.ToUpdatePostgrestConfigBody()

		assert.Nil(t, body.DbSchema)
		assert.Nil(t, body.DbExtraSearchPath)
		assert.Nil(t, body.MaxRows)
	})
}

func TestApiDiffWithRemote(t *testing.T) {
	t.Run("detects differences", func(t *testing.T) {
		api := &RemoteApi{
			Schemas:         []string{"public", "private"},
			ExtraSearchPath: []string{"extensions", "public"},
			MaxRows:         1000,
		}

		remoteConfig := v1API.PostgrestConfigWithJWTSecretResponse{
			DbSchema:          "public",
			DbExtraSearchPath: "public",
			MaxRows:           500,
		}

		diff := api.DiffWithRemote(remoteConfig)

		assert.Contains(t, string(diff), "-schemas = [\"public\"]")
		assert.Contains(t, string(diff), "+schemas = [\"public\", \"private\"]")
		assert.Contains(t, string(diff), "-extra_search_path = [\"public\"]")
		assert.Contains(t, string(diff), "+extra_search_path = [\"extensions\", \"public\"]")
		assert.Contains(t, string(diff), "-max_rows = 500")
		assert.Contains(t, string(diff), "+max_rows = 1000")
	})

	t.Run("handles no differences", func(t *testing.T) {
		api := &RemoteApi{
			Schemas:         []string{"public"},
			ExtraSearchPath: []string{"public"},
			MaxRows:         500,
		}

		remoteConfig := v1API.PostgrestConfigWithJWTSecretResponse{
			DbSchema:          "public",
			DbExtraSearchPath: "public",
			MaxRows:           500,
		}

		diff := api.DiffWithRemote(remoteConfig)

		assert.Empty(t, diff)
	})
}
