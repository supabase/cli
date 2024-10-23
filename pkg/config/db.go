package config

import (
	"fmt"
	"reflect"
	"strings"

	"github.com/google/go-cmp/cmp"
	v1API "github.com/supabase/cli/pkg/api"
	"github.com/supabase/cli/pkg/cast"
	"github.com/supabase/cli/pkg/diff"
)

type PoolMode string

const (
	TransactionMode PoolMode = "transaction"
	SessionMode     PoolMode = "session"
)

type SessionReplicationRole string

const (
	SessionReplicationRoleOrigin  SessionReplicationRole = "origin"
	SessionReplicationRoleReplica SessionReplicationRole = "replica"
	SessionReplicationRoleLocal   SessionReplicationRole = "local"
)

type (
	settings struct {
		EffectiveCacheSize            *string                 `toml:"effective_cache_size"`
		LogicalDecodingWorkMem        *string                 `toml:"logical_decoding_work_mem"`
		MaintenanceWorkMem            *string                 `toml:"maintenance_work_mem"`
		MaxConnections                *uint                   `toml:"max_connections"`
		MaxLocksPerTransaction        *uint                   `toml:"max_locks_per_transaction"`
		MaxParallelMaintenanceWorkers *uint                   `toml:"max_parallel_maintenance_workers"`
		MaxParallelWorkers            *uint                   `toml:"max_parallel_workers"`
		MaxParallelWorkersPerGather   *uint                   `toml:"max_parallel_workers_per_gather"`
		MaxReplicationSlots           *uint                   `toml:"max_replication_slots"`
		MaxSlotWalKeepSize            *string                 `toml:"max_slot_wal_keep_size"`
		MaxStandbyArchiveDelay        *string                 `toml:"max_standby_archive_delay"`
		MaxStandbyStreamingDelay      *string                 `toml:"max_standby_streaming_delay"`
		MaxWalSize                    *string                 `toml:"max_wal_size"`
		MaxWalSenders                 *uint                   `toml:"max_wal_senders"`
		MaxWorkerProcesses            *uint                   `toml:"max_worker_processes"`
		SessionReplicationRole        *SessionReplicationRole `toml:"session_replication_role"`
		SharedBuffers                 *string                 `toml:"shared_buffers"`
		StatementTimeout              *string                 `toml:"statement_timeout"`
		WalKeepSize                   *string                 `toml:"wal_keep_size"`
		WalSenderTimeout              *string                 `toml:"wal_sender_timeout"`
		WorkMem                       *string                 `toml:"work_mem"`
	}

	db struct {
		Image        string   `toml:"-"`
		Port         uint16   `toml:"port"`
		ShadowPort   uint16   `toml:"shadow_port"`
		MajorVersion uint     `toml:"major_version"`
		Password     string   `toml:"-"`
		RootKey      string   `toml:"-" mapstructure:"root_key"`
		Pooler       pooler   `toml:"pooler"`
		Seed         seed     `toml:"seed"`
		Settings     settings `toml:"settings"`
	}

	seed struct {
		Enabled      bool     `toml:"enabled"`
		GlobPatterns []string `toml:"sql_paths"`
		SqlPaths     []string `toml:"-"`
	}

	pooler struct {
		Enabled          bool     `toml:"enabled"`
		Image            string   `toml:"-"`
		Port             uint16   `toml:"port"`
		PoolMode         PoolMode `toml:"pool_mode"`
		DefaultPoolSize  uint     `toml:"default_pool_size"`
		MaxClientConn    uint     `toml:"max_client_conn"`
		ConnectionString string   `toml:"-"`
		TenantId         string   `toml:"-"`
		EncryptionKey    string   `toml:"-"`
		SecretKeyBase    string   `toml:"-"`
	}
)

// Compare two db config, if changes requires restart return true, return false otherwise
func (a settings) requireDbRestart(b settings) bool {
	return !cmp.Equal(a.MaxConnections, b.MaxConnections) ||
		!cmp.Equal(a.MaxWorkerProcesses, b.MaxWorkerProcesses) ||
		!cmp.Equal(a.MaxParallelWorkers, b.MaxParallelWorkers) ||
		!cmp.Equal(a.MaxWalSenders, b.MaxWalSenders) ||
		!cmp.Equal(a.MaxReplicationSlots, b.MaxReplicationSlots) ||
		!cmp.Equal(a.SharedBuffers, b.SharedBuffers)
}

func (a *settings) ToUpdatePostgresConfigBody() v1API.UpdatePostgresConfigBody {
	body := v1API.UpdatePostgresConfigBody{}

	// Parameters that require restart
	body.MaxConnections = cast.UintToIntPtr(a.MaxConnections)
	body.MaxWorkerProcesses = cast.UintToIntPtr(a.MaxWorkerProcesses)
	body.MaxParallelWorkers = cast.UintToIntPtr(a.MaxParallelWorkers)
	body.MaxWalSenders = cast.UintToIntPtr(a.MaxWalSenders)
	body.MaxReplicationSlots = cast.UintToIntPtr(a.MaxReplicationSlots)
	body.SharedBuffers = a.SharedBuffers

	// Parameters that can be changed without restart
	body.EffectiveCacheSize = a.EffectiveCacheSize
	body.LogicalDecodingWorkMem = a.LogicalDecodingWorkMem
	body.MaintenanceWorkMem = a.MaintenanceWorkMem
	body.MaxLocksPerTransaction = cast.UintToIntPtr(a.MaxLocksPerTransaction)
	body.MaxParallelMaintenanceWorkers = cast.UintToIntPtr(a.MaxParallelMaintenanceWorkers)
	body.MaxParallelWorkersPerGather = cast.UintToIntPtr(a.MaxParallelWorkersPerGather)
	body.MaxSlotWalKeepSize = a.MaxSlotWalKeepSize
	body.MaxStandbyArchiveDelay = a.MaxStandbyArchiveDelay
	body.MaxStandbyStreamingDelay = a.MaxStandbyStreamingDelay
	body.MaxWalSize = a.MaxWalSize
	body.SessionReplicationRole = (*v1API.UpdatePostgresConfigBodySessionReplicationRole)(a.SessionReplicationRole)
	body.StatementTimeout = a.StatementTimeout
	body.WalKeepSize = a.WalKeepSize
	body.WalSenderTimeout = a.WalSenderTimeout
	body.WorkMem = a.WorkMem
	return body
}

func (a *settings) fromRemoteConfig(remoteConfig v1API.PostgresConfigResponse) settings {
	result := *a

	result.EffectiveCacheSize = remoteConfig.EffectiveCacheSize
	result.LogicalDecodingWorkMem = remoteConfig.LogicalDecodingWorkMem
	result.MaintenanceWorkMem = remoteConfig.MaintenanceWorkMem
	result.MaxConnections = cast.IntToUintPtr(remoteConfig.MaxConnections)
	result.MaxLocksPerTransaction = cast.IntToUintPtr(remoteConfig.MaxLocksPerTransaction)
	result.MaxParallelMaintenanceWorkers = cast.IntToUintPtr(remoteConfig.MaxParallelMaintenanceWorkers)
	result.MaxParallelWorkers = cast.IntToUintPtr(remoteConfig.MaxParallelWorkers)
	result.MaxParallelWorkersPerGather = cast.IntToUintPtr(remoteConfig.MaxParallelWorkersPerGather)
	result.MaxReplicationSlots = cast.IntToUintPtr(remoteConfig.MaxReplicationSlots)
	result.MaxSlotWalKeepSize = remoteConfig.MaxSlotWalKeepSize
	result.MaxStandbyArchiveDelay = remoteConfig.MaxStandbyArchiveDelay
	result.MaxStandbyStreamingDelay = remoteConfig.MaxStandbyStreamingDelay
	result.MaxWalSenders = cast.IntToUintPtr(remoteConfig.MaxWalSenders)
	result.MaxWalSize = remoteConfig.MaxWalSize
	result.MaxWorkerProcesses = cast.IntToUintPtr(remoteConfig.MaxWorkerProcesses)
	result.SessionReplicationRole = (*SessionReplicationRole)(remoteConfig.SessionReplicationRole)
	result.SharedBuffers = remoteConfig.SharedBuffers
	result.StatementTimeout = remoteConfig.StatementTimeout
	result.WalKeepSize = remoteConfig.WalKeepSize
	result.WalSenderTimeout = remoteConfig.WalSenderTimeout
	result.WorkMem = remoteConfig.WorkMem
	return result
}

func (a *settings) ToPostgresConfig() string {
	// create a valid string to append to /etc/postgresql/postgresql.conf
	var config strings.Builder

	// Helper function to add a setting if it's not nil
	addSetting := func(name string, value interface{}) {
		if value != nil {
			switch v := value.(type) {
			case *string:
				if v != nil {
					fmt.Fprintf(&config, "%s = '%s'\n", name, *v)
				}
			case *int:
				if v != nil {
					fmt.Fprintf(&config, "%s = %d\n", name, *v)
				}
			case *SessionReplicationRole:
				if v != nil {
					fmt.Fprintf(&config, "%s = '%s'\n", name, string(*v))
				}
			default:
				// For other types, only add if it's a non-nil pointer
				if reflect.ValueOf(value).Kind() == reflect.Ptr && !reflect.ValueOf(value).IsNil() {
					fmt.Fprintf(&config, "%s = %v\n", name, reflect.ValueOf(value).Elem().Interface())
				}
			}
		}
	}

	// Add all the settings
	addSetting("effective_cache_size", a.EffectiveCacheSize)
	addSetting("logical_decoding_work_mem", a.LogicalDecodingWorkMem)
	addSetting("maintenance_work_mem", a.MaintenanceWorkMem)
	addSetting("max_connections", a.MaxConnections)
	addSetting("max_locks_per_transaction", a.MaxLocksPerTransaction)
	addSetting("max_parallel_maintenance_workers", a.MaxParallelMaintenanceWorkers)
	addSetting("max_parallel_workers", a.MaxParallelWorkers)
	addSetting("max_parallel_workers_per_gather", a.MaxParallelWorkersPerGather)
	addSetting("max_replication_slots", a.MaxReplicationSlots)
	addSetting("max_slot_wal_keep_size", a.MaxSlotWalKeepSize)
	addSetting("max_standby_archive_delay", a.MaxStandbyArchiveDelay)
	addSetting("max_standby_streaming_delay", a.MaxStandbyStreamingDelay)
	addSetting("max_wal_senders", a.MaxWalSenders)
	addSetting("max_wal_size", a.MaxWalSize)
	addSetting("max_worker_processes", a.MaxWorkerProcesses)
	if a.SessionReplicationRole != nil {
		addSetting("session_replication_role", string(*a.SessionReplicationRole))
	}
	addSetting("shared_buffers", a.SharedBuffers)
	addSetting("statement_timeout", a.StatementTimeout)
	addSetting("wal_keep_size", a.WalKeepSize)
	addSetting("wal_sender_timeout", a.WalSenderTimeout)
	addSetting("work_mem", a.WorkMem)

	return config.String()
}

func (a *settings) DiffWithRemote(remoteConfig v1API.PostgresConfigResponse) ([]byte, error) {
	// Convert the config values into easily comparable remoteConfig values
	currentValue, err := ToTomlBytes(a)
	if err != nil {
		return nil, err
	}
	remoteCompare, err := ToTomlBytes(a.fromRemoteConfig(remoteConfig))
	if err != nil {
		return nil, err
	}
	return diff.Diff("remote[db.settings]", remoteCompare, "local[db.settings]", currentValue), nil
}
