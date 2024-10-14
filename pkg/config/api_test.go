package config

import (
	"fmt"
	"testing"

	"github.com/stretchr/testify/assert"
	v1API "github.com/supabase/cli/pkg/api"
)

func TestApiToUpdatePostgrestConfigBody(t *testing.T) {
	t.Run("converts all fields correctly", func(t *testing.T) {
		api := &RemoteApi{
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
		api := &RemoteApi{}

		body := api.ToUpdatePostgrestConfigBody()

		// remote api will be false by default, leading to an empty schema on api side
		assert.Equal(t, "", *body.DbSchema)
	})
}

func TestApiDiffWithRemote(t *testing.T) {
	t.Run("detects differences", func(t *testing.T) {
		api := &RemoteApi{
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

		diff := api.DiffWithRemote(remoteConfig)

		assert.Empty(t, diff)
	})
	t.Run("handles multiple schemas and search paths with spaces", func(t *testing.T) {
		api := &RemoteApi{
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

		diff := api.DiffWithRemote(remoteConfig)

		assert.Empty(t, diff)
	})
	t.Run("handles api disabled on remote side", func(t *testing.T) {
		api := &RemoteApi{
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

		diff := api.DiffWithRemote(remoteConfig)
		d := string(diff)
		fmt.Println(d)

		assert.Contains(t, string(diff), "-enabled = false")
		assert.Contains(t, string(diff), "+enabled = true")
	})
	t.Run("handles api disabled on local side", func(t *testing.T) {
		api := &RemoteApi{
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

		diff := api.DiffWithRemote(remoteConfig)
		d := string(diff)
		fmt.Println(d)

		assert.Contains(t, string(diff), "-enabled = true")
		assert.Contains(t, string(diff), "+enabled = false")
	})
}
