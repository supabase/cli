package config

import (
	"testing"

	"github.com/stretchr/testify/assert"
	v1API "github.com/supabase/cli/pkg/api"
	"github.com/supabase/cli/pkg/cast"
)

func TestDbSettingsToUpdatePostgresConfigBody(t *testing.T) {
	t.Run("converts all fields correctly", func(t *testing.T) {
		db := &db{
			Settings: settings{
				EffectiveCacheSize:     cast.Ptr("4GB"),
				MaxConnections:         cast.Ptr(uint(100)),
				SharedBuffers:          cast.Ptr("1GB"),
				StatementTimeout:       cast.Ptr("30s"),
				SessionReplicationRole: cast.Ptr(SessionReplicationRoleReplica),
			},
		}

		body := db.Settings.ToUpdatePostgresConfigBody()

		assert.Equal(t, "4GB", *body.EffectiveCacheSize)
		assert.Equal(t, 100, *body.MaxConnections)
		assert.Equal(t, "1GB", *body.SharedBuffers)
		assert.Equal(t, "30s", *body.StatementTimeout)
		assert.Equal(t, v1API.UpdatePostgresConfigBodySessionReplicationRoleReplica, *body.SessionReplicationRole)
	})

	t.Run("handles empty fields", func(t *testing.T) {
		db := &db{}

		body := db.Settings.ToUpdatePostgresConfigBody()

		assert.Nil(t, body.EffectiveCacheSize)
		assert.Nil(t, body.MaxConnections)
		assert.Nil(t, body.SharedBuffers)
		assert.Nil(t, body.StatementTimeout)
		assert.Nil(t, body.SessionReplicationRole)
	})
}

func TestDbSettingsDiffWithRemote(t *testing.T) {
	t.Run("detects differences", func(t *testing.T) {
		db := &db{
			Settings: settings{
				EffectiveCacheSize: cast.Ptr("4GB"),
				MaxConnections:     cast.Ptr(uint(100)),
				SharedBuffers:      cast.Ptr("1GB"),
			},
		}

		remoteConfig := v1API.PostgresConfigResponse{
			EffectiveCacheSize: cast.Ptr("8GB"),
			MaxConnections:     cast.Ptr(200),
			SharedBuffers:      cast.Ptr("2GB"),
		}

		diff, err := db.Settings.DiffWithRemote(remoteConfig)
		assert.NoError(t, err)

		assert.Contains(t, string(diff), "-effective_cache_size = \"8GB\"")
		assert.Contains(t, string(diff), "+effective_cache_size = \"4GB\"")
		assert.Contains(t, string(diff), "-max_connections = 200")
		assert.Contains(t, string(diff), "+max_connections = 100")
		assert.Contains(t, string(diff), "-shared_buffers = \"2GB\"")
		assert.Contains(t, string(diff), "+shared_buffers = \"1GB\"")
	})

	t.Run("handles no differences", func(t *testing.T) {
		db := &db{
			Settings: settings{
				EffectiveCacheSize: cast.Ptr("4GB"),
				MaxConnections:     cast.Ptr(uint(100)),
				SharedBuffers:      cast.Ptr("1GB"),
			},
		}

		remoteConfig := v1API.PostgresConfigResponse{
			EffectiveCacheSize: cast.Ptr("4GB"),
			MaxConnections:     cast.Ptr(100),
			SharedBuffers:      cast.Ptr("1GB"),
		}

		diff, err := db.Settings.DiffWithRemote(remoteConfig)
		assert.NoError(t, err)

		assert.Empty(t, diff)
	})

	t.Run("handles multiple schemas and search paths with spaces", func(t *testing.T) {
		db := &db{
			Settings: settings{
				EffectiveCacheSize: cast.Ptr("4GB"),
				MaxConnections:     cast.Ptr(uint(100)),
				SharedBuffers:      cast.Ptr("1GB"),
			},
		}

		remoteConfig := v1API.PostgresConfigResponse{
			EffectiveCacheSize: cast.Ptr("4GB"),
			MaxConnections:     cast.Ptr(100),
			SharedBuffers:      cast.Ptr("1GB"),
		}

		diff, err := db.Settings.DiffWithRemote(remoteConfig)
		assert.NoError(t, err)

		assert.Empty(t, diff)
	})

	t.Run("handles api disabled on remote side", func(t *testing.T) {
		db := &db{
			Settings: settings{
				EffectiveCacheSize: cast.Ptr("4GB"),
				MaxConnections:     cast.Ptr(uint(100)),
				SharedBuffers:      cast.Ptr("1GB"),
			},
		}

		remoteConfig := v1API.PostgresConfigResponse{
			// All fields are nil to simulate disabled API
		}

		diff, err := db.Settings.DiffWithRemote(remoteConfig)
		assert.NoError(t, err)

		assert.Contains(t, string(diff), "+effective_cache_size = \"4GB\"")
		assert.Contains(t, string(diff), "+max_connections = 100")
		assert.Contains(t, string(diff), "+shared_buffers = \"1GB\"")
	})

	t.Run("handles api disabled on local side", func(t *testing.T) {
		db := &db{
			Settings: settings{
				// All fields are nil to simulate disabled API
			},
		}

		remoteConfig := v1API.PostgresConfigResponse{
			EffectiveCacheSize: cast.Ptr("4GB"),
			MaxConnections:     cast.Ptr(100),
			SharedBuffers:      cast.Ptr("1GB"),
		}

		diff, err := db.Settings.DiffWithRemote(remoteConfig)
		assert.NoError(t, err)

		assert.Contains(t, string(diff), "-effective_cache_size = \"4GB\"")
		assert.Contains(t, string(diff), "-max_connections = 100")
		assert.Contains(t, string(diff), "-shared_buffers = \"1GB\"")
	})
}
