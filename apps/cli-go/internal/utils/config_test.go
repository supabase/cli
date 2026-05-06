package utils

import (
	"os"
	"testing"

	"github.com/spf13/afero"
	"github.com/spf13/viper"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestGetId(t *testing.T) {
	t.Run("generates container id", func(t *testing.T) {
		Config.ProjectId = "test-project"
		name := "test-service"

		id := GetId(name)

		assert.Equal(t, "supabase_test-service_test-project", id)
	})
}

func TestUpdateDockerIds(t *testing.T) {
	t.Run("updates all container ids", func(t *testing.T) {
		Config.ProjectId = "test-project"
		viper.Set("network-id", "custom-network")
		defer viper.Reset()

		UpdateDockerIds()

		assert.Equal(t, "custom-network", NetId)
		assert.Equal(t, "supabase_db_test-project", DbId)
		assert.Equal(t, "supabase_kong_test-project", KongId)
		assert.Equal(t, "supabase_auth_test-project", GotrueId)
		assert.Equal(t, "supabase_inbucket_test-project", InbucketId)
		assert.Equal(t, "supabase_realtime_test-project", RealtimeId)
		assert.Equal(t, "supabase_rest_test-project", RestId)
		assert.Equal(t, "supabase_storage_test-project", StorageId)
		assert.Equal(t, "supabase_imgproxy_test-project", ImgProxyId)
		assert.Equal(t, "supabase_differ_test-project", DifferId)
		assert.Equal(t, "supabase_pg_meta_test-project", PgmetaId)
		assert.Equal(t, "supabase_studio_test-project", StudioId)
		assert.Equal(t, "supabase_edge_runtime_test-project", EdgeRuntimeId)
		assert.Equal(t, "supabase_analytics_test-project", LogflareId)
		assert.Equal(t, "supabase_vector_test-project", VectorId)
		assert.Equal(t, "supabase_pooler_test-project", PoolerId)
	})

	t.Run("generates network id if not set", func(t *testing.T) {
		Config.ProjectId = "test-project"
		viper.Reset()

		UpdateDockerIds()

		assert.Equal(t, "supabase_network_test-project", NetId)
	})
}

func TestInitConfig(t *testing.T) {
	t.Run("creates new config file", func(t *testing.T) {
		fsys := afero.NewMemMapFs()
		params := InitParams{
			ProjectId: "test-project",
		}

		err := InitConfig(params, fsys)

		assert.NoError(t, err)
		exists, err := afero.Exists(fsys, ConfigPath)
		assert.NoError(t, err)
		assert.True(t, exists)
	})

	t.Run("creates config with orioledb", func(t *testing.T) {
		fsys := afero.NewMemMapFs()
		params := InitParams{
			ProjectId:   "test-project",
			UseOrioleDB: true,
		}

		err := InitConfig(params, fsys)

		assert.NoError(t, err)
		content, err := afero.ReadFile(fsys, ConfigPath)
		assert.NoError(t, err)
		assert.Contains(t, string(content), "15.1.0.150")
	})

	t.Run("fails if config exists and no overwrite", func(t *testing.T) {
		fsys := afero.NewMemMapFs()
		err := afero.WriteFile(fsys, ConfigPath, []byte("existing"), 0644)
		require.NoError(t, err)
		params := InitParams{
			ProjectId: "test-project",
		}

		err = InitConfig(params, fsys)

		assert.ErrorIs(t, err, os.ErrExist)
	})

	t.Run("overwrites existing config when specified", func(t *testing.T) {
		fsys := afero.NewMemMapFs()
		err := afero.WriteFile(fsys, ConfigPath, []byte("existing"), 0644)
		require.NoError(t, err)
		params := InitParams{
			ProjectId: "test-project",
			Overwrite: true,
		}

		err = InitConfig(params, fsys)

		assert.NoError(t, err)
		content, err := afero.ReadFile(fsys, ConfigPath)
		assert.NoError(t, err)
		assert.NotEqual(t, "existing", string(content))
	})
}

func TestGetApiUrl(t *testing.T) {
	t.Run("returns external url when configured", func(t *testing.T) {
		Config.Api.ExternalUrl = "https://api.example.com"

		url := GetApiUrl("/test")

		assert.Equal(t, "https://api.example.com/test", url)
	})

	t.Run("builds url from hostname and port", func(t *testing.T) {
		Config.Hostname = "localhost"
		Config.Api.Port = 8000
		Config.Api.ExternalUrl = ""

		url := GetApiUrl("/test")

		assert.Equal(t, "http://localhost:8000/test", url)
	})
}

func TestRootFS(t *testing.T) {
	t.Run("opens file from root fs", func(t *testing.T) {
		fsys := afero.NewMemMapFs()
		content := []byte("test content")
		err := afero.WriteFile(fsys, "/test.txt", content, 0644)
		require.NoError(t, err)

		rootfs := NewRootFS(fsys)
		f, err := rootfs.Open("/test.txt")
		assert.NoError(t, err)
		defer f.Close()

		buf := make([]byte, len(content))
		n, err := f.Read(buf)
		assert.NoError(t, err)
		assert.Equal(t, len(content), n)
		assert.Equal(t, content, buf)
	})

	t.Run("returns error for non-existent file", func(t *testing.T) {
		fsys := afero.NewMemMapFs()
		rootfs := NewRootFS(fsys)

		_, err := rootfs.Open("/non-existent.txt")

		assert.Error(t, err)
	})
}
