package config

import (
	"bytes"
	"io"
	"os"
	"testing"
	fs "testing/fstest"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
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

func TestApiAutoExposeNewTablesDefault(t *testing.T) {
	t.Run("is unset on a fresh config so the implicit revoke-by-default behaviour applies", func(t *testing.T) {
		cfg := NewConfig()
		assert.Nil(t, cfg.Api.AutoExposeNewTables)
	})
}

func TestApiAutoExposeNewTablesWarning(t *testing.T) {
	captureStderr := func(t *testing.T, run func()) string {
		t.Helper()
		r, w, err := os.Pipe()
		require.NoError(t, err)
		orig := os.Stderr
		os.Stderr = w
		defer func() { os.Stderr = orig }()
		run()
		require.NoError(t, w.Close())
		var out bytes.Buffer
		_, err = io.Copy(&out, r)
		require.NoError(t, err)
		return out.String()
	}

	t.Run("warns when auto_expose_new_tables is explicitly true", func(t *testing.T) {
		cfg := NewConfig()
		fsys := fs.MapFS{"config.toml": &fs.MapFile{Data: []byte("[api]\nauto_expose_new_tables = true\n")}}
		stderr := captureStderr(t, func() {
			require.NoError(t, cfg.Load("config.toml", fsys))
		})
		require.NotNil(t, cfg.Api.AutoExposeNewTables)
		assert.True(t, *cfg.Api.AutoExposeNewTables)
		assert.Contains(t, stderr, "api.auto_expose_new_tables is deprecated")
		assert.Contains(t, stderr, "2026-10-30")
	})

	t.Run("does not warn when unset", func(t *testing.T) {
		cfg := NewConfig()
		stderr := captureStderr(t, func() {
			require.NoError(t, cfg.Load("", fs.MapFS{}))
		})
		assert.Nil(t, cfg.Api.AutoExposeNewTables)
		assert.NotContains(t, stderr, "auto_expose_new_tables is deprecated")
	})

	t.Run("does not warn when explicitly false", func(t *testing.T) {
		cfg := NewConfig()
		fsys := fs.MapFS{"config.toml": &fs.MapFile{Data: []byte("[api]\nauto_expose_new_tables = false\n")}}
		stderr := captureStderr(t, func() {
			require.NoError(t, cfg.Load("config.toml", fsys))
		})
		require.NotNil(t, cfg.Api.AutoExposeNewTables)
		assert.False(t, *cfg.Api.AutoExposeNewTables)
		assert.NotContains(t, stderr, "auto_expose_new_tables is deprecated")
	})
}
