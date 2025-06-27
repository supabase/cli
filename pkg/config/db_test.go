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

func TestNetworkRestrictionsToUpdateBody(t *testing.T) {
	t.Run("converts disabled restrictions into allow_all", func(t *testing.T) {
		nr := NetworkRestrictions{
			Enabled:          false,
			DbAllowedCidrs:   []string{},
			DbAllowedCidrsV6: []string{},
		}
		body := nr.ToUpdateNetworkRestrictionsBody()
		assert.Equal(t, []string{"0.0.0.0/0"}, *body.DbAllowedCidrs)
		assert.Equal(t, []string{"::/0"}, *body.DbAllowedCidrsV6)
	})

	t.Run("converts disabled restrictions", func(t *testing.T) {
		nr := NetworkRestrictions{
			Enabled:          false,
			DbAllowedCidrs:   []string{"192.168.1.0/24", "10.0.0.0/8"},
			DbAllowedCidrsV6: []string{"2001:db8::/32"},
		}
		body := nr.ToUpdateNetworkRestrictionsBody()
		assert.Equal(t, []string{"0.0.0.0/0"}, *body.DbAllowedCidrs)
		assert.Equal(t, []string{"::/0"}, *body.DbAllowedCidrsV6)
	})

	t.Run("converts enabled restrictions with defaults", func(t *testing.T) {
		nr := NetworkRestrictions{
			Enabled:          true,
			DbAllowedCidrs:   []string{},
			DbAllowedCidrsV6: []string{},
		}
		body := nr.ToUpdateNetworkRestrictionsBody()
		assert.Equal(t, []string{}, *body.DbAllowedCidrs)
		assert.Equal(t, []string{}, *body.DbAllowedCidrsV6)
	})

	t.Run("converts populated restrictions", func(t *testing.T) {
		nr := NetworkRestrictions{
			Enabled:          true,
			DbAllowedCidrs:   []string{"192.168.1.0/24", "10.0.0.0/8"},
			DbAllowedCidrsV6: []string{"2001:db8::/32"},
		}
		body := nr.ToUpdateNetworkRestrictionsBody()
		assert.Equal(t, []string{"192.168.1.0/24", "10.0.0.0/8"}, *body.DbAllowedCidrs)
		assert.Equal(t, []string{"2001:db8::/32"}, *body.DbAllowedCidrsV6)
	})

	t.Run("converts enabled restrictions with nil cidrs", func(t *testing.T) {
		nr := NetworkRestrictions{
			Enabled: true,
			// DbAllowedCidrs and DbAllowedCidrsV6 are nil (not initialized)
		}
		// Simulate config validation that would happen during parsing
		nr.validate()
		body := nr.ToUpdateNetworkRestrictionsBody()
		assert.Equal(t, []string{}, *body.DbAllowedCidrs)
		assert.Equal(t, []string{}, *body.DbAllowedCidrsV6)
	})
}

func TestNetworkRestrictionsValidate(t *testing.T) {
	t.Run("initializes empty arrays when enabled is true and arrays are nil", func(t *testing.T) {
		nr := NetworkRestrictions{
			Enabled: true,
			// DbAllowedCidrs and DbAllowedCidrsV6 are nil
		}
		nr.validate()
		assert.NotNil(t, nr.DbAllowedCidrs)
		assert.NotNil(t, nr.DbAllowedCidrsV6)
		assert.Equal(t, []string{}, nr.DbAllowedCidrs)
		assert.Equal(t, []string{}, nr.DbAllowedCidrsV6)
	})

	t.Run("preserves existing arrays when enabled is true", func(t *testing.T) {
		nr := NetworkRestrictions{
			Enabled:          true,
			DbAllowedCidrs:   []string{"192.168.1.0/24"},
			DbAllowedCidrsV6: []string{"2001:db8::/32"},
		}
		nr.validate()
		assert.Equal(t, []string{"192.168.1.0/24"}, nr.DbAllowedCidrs)
		assert.Equal(t, []string{"2001:db8::/32"}, nr.DbAllowedCidrsV6)
	})

	t.Run("does not initialize arrays when enabled is false", func(t *testing.T) {
		nr := NetworkRestrictions{
			Enabled: false,
			// DbAllowedCidrs and DbAllowedCidrsV6 are nil
		}
		nr.validate()
		assert.Nil(t, nr.DbAllowedCidrs)
		assert.Nil(t, nr.DbAllowedCidrsV6)
	})
}

func TestNetworkRestrictionsFromRemote(t *testing.T) {
	t.Run("converts from remote config with restrictions", func(t *testing.T) {
		ipv4Cidrs := []string{"192.168.1.0/24"}
		ipv6Cidrs := []string{"2001:db8::/32"}
		remoteConfig := v1API.NetworkRestrictionsResponse{
			Config: struct {
				DbAllowedCidrs   *[]string `json:"dbAllowedCidrs,omitempty"`
				DbAllowedCidrsV6 *[]string `json:"dbAllowedCidrsV6,omitempty"`
			}{
				DbAllowedCidrs:   &ipv4Cidrs,
				DbAllowedCidrsV6: &ipv6Cidrs,
			},
		}
		nr := NetworkRestrictions{}
		nr.FromRemoteNetworkRestrictions(remoteConfig)
		assert.True(t, nr.Enabled)
		assert.Equal(t, []string{"192.168.1.0/24"}, nr.DbAllowedCidrs)
		assert.Equal(t, []string{"2001:db8::/32"}, nr.DbAllowedCidrsV6)
	})

	t.Run("converts from remote config with allow all", func(t *testing.T) {
		ipv4Cidrs := []string{"0.0.0.0/0"}
		ipv6Cidrs := []string{"::/0"}
		remoteConfig := v1API.NetworkRestrictionsResponse{
			Config: struct {
				DbAllowedCidrs   *[]string `json:"dbAllowedCidrs,omitempty"`
				DbAllowedCidrsV6 *[]string `json:"dbAllowedCidrsV6,omitempty"`
			}{
				DbAllowedCidrs:   &ipv4Cidrs,
				DbAllowedCidrsV6: &ipv6Cidrs,
			},
		}
		nr := NetworkRestrictions{}
		nr.FromRemoteNetworkRestrictions(remoteConfig)
		assert.False(t, nr.Enabled)
		assert.Equal(t, []string{"0.0.0.0/0"}, nr.DbAllowedCidrs)
		assert.Equal(t, []string{"::/0"}, nr.DbAllowedCidrsV6)
	})
}

func TestNetworkRestrictionsDiff(t *testing.T) {
	t.Run("detects differences", func(t *testing.T) {
		local := NetworkRestrictions{
			Enabled:          true,
			DbAllowedCidrs:   []string{"192.168.1.0/24"},
			DbAllowedCidrsV6: []string{"2001:db8::/32"},
		}
		ipv4Cidrs := []string{"10.0.0.0/8"}
		ipv6Cidrs := []string{"2001:db8::/32"}
		remoteConfig := v1API.NetworkRestrictionsResponse{
			Config: struct {
				DbAllowedCidrs   *[]string `json:"dbAllowedCidrs,omitempty"`
				DbAllowedCidrsV6 *[]string `json:"dbAllowedCidrsV6,omitempty"`
			}{
				DbAllowedCidrs:   &ipv4Cidrs,
				DbAllowedCidrsV6: &ipv6Cidrs,
			},
		}
		diff, err := local.DiffWithRemote(remoteConfig)
		assert.NoError(t, err)
		assert.Contains(t, string(diff), "-db_allowed_cidrs = [\"10.0.0.0/8\"]")
		assert.Contains(t, string(diff), "+db_allowed_cidrs = [\"192.168.1.0/24\"]")
		assert.Contains(t, string(diff), " db_allowed_cidrs_v6 = [\"2001:db8::/32\"]")
	})

	t.Run("no differences", func(t *testing.T) {
		local := NetworkRestrictions{
			Enabled:          true,
			DbAllowedCidrs:   []string{"192.168.1.0/24"},
			DbAllowedCidrsV6: []string{"2001:db8::/32"},
		}
		ipv4Cidrs := []string{"192.168.1.0/24"}
		ipv6Cidrs := []string{"2001:db8::/32"}
		remoteConfig := v1API.NetworkRestrictionsResponse{
			Config: struct {
				DbAllowedCidrs   *[]string `json:"dbAllowedCidrs,omitempty"`
				DbAllowedCidrsV6 *[]string `json:"dbAllowedCidrsV6,omitempty"`
			}{
				DbAllowedCidrs:   &ipv4Cidrs,
				DbAllowedCidrsV6: &ipv6Cidrs,
			},
		}
		diff, err := local.DiffWithRemote(remoteConfig)
		assert.NoError(t, err)
		assert.Empty(t, diff)
	})

	t.Run("both have no restrictions - disabled vs allow all", func(t *testing.T) {
		local := NetworkRestrictions{
			Enabled:          false,
			DbAllowedCidrs:   []string{},
			DbAllowedCidrsV6: []string{},
		}
		ipv4Cidrs := []string{"0.0.0.0/0"}
		ipv6Cidrs := []string{"::/0"}
		remoteConfig := v1API.NetworkRestrictionsResponse{
			Config: struct {
				DbAllowedCidrs   *[]string `json:"dbAllowedCidrs,omitempty"`
				DbAllowedCidrsV6 *[]string `json:"dbAllowedCidrsV6,omitempty"`
			}{
				DbAllowedCidrs:   &ipv4Cidrs,
				DbAllowedCidrsV6: &ipv6Cidrs,
			},
		}
		diff, err := local.DiffWithRemote(remoteConfig)
		assert.NoError(t, err)
		assert.Empty(t, diff)
	})

	t.Run("local disallow all, remote allow all", func(t *testing.T) {
		local := NetworkRestrictions{
			Enabled:          true,
			DbAllowedCidrs:   []string{},
			DbAllowedCidrsV6: []string{},
		}
		ipv4Cidrs := []string{"0.0.0.0/0"}
		ipv6Cidrs := []string{"::/0"}
		remoteConfig := v1API.NetworkRestrictionsResponse{
			Config: struct {
				DbAllowedCidrs   *[]string `json:"dbAllowedCidrs,omitempty"`
				DbAllowedCidrsV6 *[]string `json:"dbAllowedCidrsV6,omitempty"`
			}{
				DbAllowedCidrs:   &ipv4Cidrs,
				DbAllowedCidrsV6: &ipv6Cidrs,
			},
		}
		diff, err := local.DiffWithRemote(remoteConfig)
		assert.NoError(t, err)
		assert.Contains(t, string(diff), "-db_allowed_cidrs = [\"0.0.0.0/0\"]")
		assert.Contains(t, string(diff), "+db_allowed_cidrs = []")
		assert.Contains(t, string(diff), "-db_allowed_cidrs_v6 = [\"::/0\"]")
		assert.Contains(t, string(diff), "+db_allowed_cidrs_v6 = []")
	})

	t.Run("local config is nil (not present at all)", func(t *testing.T) {
		// Simulate remote has allow all (default)
		ipv4Cidrs := []string{"0.0.0.0/0"}
		ipv6Cidrs := []string{"::/0"}
		remoteConfig := v1API.NetworkRestrictionsResponse{
			Config: struct {
				DbAllowedCidrs   *[]string `json:"dbAllowedCidrs,omitempty"`
				DbAllowedCidrsV6 *[]string `json:"dbAllowedCidrsV6,omitempty"`
			}{
				DbAllowedCidrs:   &ipv4Cidrs,
				DbAllowedCidrsV6: &ipv6Cidrs,
			},
		}
		var local *NetworkRestrictions = nil
		diff, err := local.DiffWithRemote(remoteConfig)
		assert.NoError(t, err)
		assert.Empty(t, diff)
	})
}
