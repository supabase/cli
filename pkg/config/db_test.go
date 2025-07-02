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

func TestDbSettingsDiff(t *testing.T) {
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

		assertSnapshotEqual(t, diff)
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

		assertSnapshotEqual(t, diff)
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

		assertSnapshotEqual(t, diff)
	})
}

func TestSettingsToPostgresConfig(t *testing.T) {
	t.Run("Only set values should appear", func(t *testing.T) {
		settings := settings{
			MaxConnections:         cast.Ptr(uint(100)),
			MaxLocksPerTransaction: cast.Ptr(uint(64)),
			SharedBuffers:          cast.Ptr("128MB"),
			WorkMem:                cast.Ptr("4MB"),
		}
		got := settings.ToPostgresConfig()

		assert.Contains(t, got, "max_connections = 100")
		assert.Contains(t, got, "max_locks_per_transaction = 64")
		assert.Contains(t, got, "shared_buffers = '128MB'")
		assert.Contains(t, got, "work_mem = '4MB'")

		assert.NotContains(t, got, "effective_cache_size")
		assert.NotContains(t, got, "maintenance_work_mem")
		assert.NotContains(t, got, "max_parallel_workers")
	})

	t.Run("SessionReplicationRole should be handled correctly", func(t *testing.T) {
		settings := settings{
			SessionReplicationRole: cast.Ptr(SessionReplicationRoleOrigin),
		}
		got := settings.ToPostgresConfig()

		assert.Contains(t, got, "session_replication_role = 'origin'")
	})

	t.Run("Empty settings should result in empty string", func(t *testing.T) {
		settings := settings{}
		got := settings.ToPostgresConfig()

		assert.Equal(t, got, "\n# supabase [db.settings] configuration\n")
		assert.NotContains(t, got, "=")
	})
}

func TestNetworkRestrictionsFromRemote(t *testing.T) {
	t.Run("converts from remote config with restrictions", func(t *testing.T) {
		ipv4Cidrs := []string{"192.168.1.0/24"}
		ipv6Cidrs := []string{"2001:db8::/32"}
		remoteConfig := v1API.NetworkRestrictionsResponse{}
		remoteConfig.Config.DbAllowedCidrs = &ipv4Cidrs
		remoteConfig.Config.DbAllowedCidrsV6 = &ipv6Cidrs
		nr := networkRestrictions{Enabled: true}
		nr.FromRemoteNetworkRestrictions(remoteConfig)
		assert.ElementsMatch(t, ipv4Cidrs, nr.AllowedCidrs)
		assert.ElementsMatch(t, ipv6Cidrs, nr.AllowedCidrsV6)
	})

	t.Run("converts from remote config with allow all", func(t *testing.T) {
		ipv4Cidrs := []string{"0.0.0.0/0"}
		ipv6Cidrs := []string{"::/0"}
		remoteConfig := v1API.NetworkRestrictionsResponse{}
		remoteConfig.Config.DbAllowedCidrs = &ipv4Cidrs
		remoteConfig.Config.DbAllowedCidrsV6 = &ipv6Cidrs
		nr := networkRestrictions{Enabled: true}
		nr.FromRemoteNetworkRestrictions(remoteConfig)
		assert.ElementsMatch(t, ipv4Cidrs, nr.AllowedCidrs)
		assert.ElementsMatch(t, ipv6Cidrs, nr.AllowedCidrsV6)
	})

	t.Run("ignores locally disabled network restrictions", func(t *testing.T) {
		remoteConfig := v1API.NetworkRestrictionsResponse{}
		remoteConfig.Config.DbAllowedCidrs = &[]string{"192.168.1.0/24"}
		remoteConfig.Config.DbAllowedCidrsV6 = &[]string{"2001:db8::/32"}
		nr := networkRestrictions{}
		nr.FromRemoteNetworkRestrictions(remoteConfig)
		assert.False(t, nr.Enabled)
		assert.Empty(t, nr.AllowedCidrs)
		assert.Empty(t, nr.AllowedCidrsV6)
	})
}

func TestNetworkRestrictionsDiff(t *testing.T) {
	t.Run("detects differences", func(t *testing.T) {
		local := networkRestrictions{
			Enabled:        true,
			AllowedCidrs:   []string{"192.168.1.0/24"},
			AllowedCidrsV6: []string{"2001:db8::/32"},
		}
		remoteConfig := v1API.NetworkRestrictionsResponse{}
		remoteConfig.Config.DbAllowedCidrs = &[]string{"10.0.0.0/8"}
		remoteConfig.Config.DbAllowedCidrsV6 = &[]string{"fd00::/8"}
		diff, err := local.DiffWithRemote(remoteConfig)
		assert.NoError(t, err)
		assert.Contains(t, string(diff), "-db_allowed_cidrs = [\"10.0.0.0/8\"]")
		assert.Contains(t, string(diff), "+db_allowed_cidrs = [\"192.168.1.0/24\"]")
		assert.Contains(t, string(diff), "-db_allowed_cidrs_v6 = [\"2001:db8::/32\"]")
		assert.Contains(t, string(diff), "+db_allowed_cidrs_v6 = [\"fd00::/8\"]")
	})

	t.Run("no differences", func(t *testing.T) {
		local := networkRestrictions{
			Enabled:        true,
			AllowedCidrs:   []string{"192.168.1.0/24"},
			AllowedCidrsV6: []string{"2001:db8::/32"},
		}
		remoteConfig := v1API.NetworkRestrictionsResponse{}
		remoteConfig.Config.DbAllowedCidrs = &local.AllowedCidrs
		remoteConfig.Config.DbAllowedCidrsV6 = &local.AllowedCidrsV6
		diff, err := local.DiffWithRemote(remoteConfig)
		assert.NoError(t, err)
		assert.Empty(t, diff)
	})

	t.Run("both have no restrictions - disabled vs allow all", func(t *testing.T) {
		local := networkRestrictions{}
		remoteConfig := v1API.NetworkRestrictionsResponse{}
		remoteConfig.Config.DbAllowedCidrs = &[]string{"0.0.0.0/0"}
		remoteConfig.Config.DbAllowedCidrsV6 = &[]string{"::/0"}
		diff, err := local.DiffWithRemote(remoteConfig)
		assert.NoError(t, err)
		assert.Empty(t, diff)
	})

	t.Run("local disallow all, remote allow all", func(t *testing.T) {
		local := networkRestrictions{
			Enabled:        true,
			AllowedCidrs:   []string{},
			AllowedCidrsV6: []string{},
		}
		remoteConfig := v1API.NetworkRestrictionsResponse{}
		remoteConfig.Config.DbAllowedCidrs = &[]string{"0.0.0.0/0"}
		remoteConfig.Config.DbAllowedCidrsV6 = &[]string{"::/0"}
		diff, err := local.DiffWithRemote(remoteConfig)
		assert.NoError(t, err)
		assert.Contains(t, string(diff), "-db_allowed_cidrs = [\"0.0.0.0/0\"]")
		assert.Contains(t, string(diff), "+db_allowed_cidrs = []")
		assert.Contains(t, string(diff), "-db_allowed_cidrs_v6 = [\"::/0\"]")
		assert.Contains(t, string(diff), "+db_allowed_cidrs_v6 = []")
	})
}
