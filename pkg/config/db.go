package config

import (
	v1API "github.com/supabase/cli/pkg/api"
	"github.com/supabase/cli/pkg/cast"
	"github.com/supabase/cli/pkg/diff"
)

type (
	PoolMode string
	settings struct {
		EffectiveCacheSize            *string `toml:"effective_cache_size"`
		LogicalDecodingWorkMem        *string `toml:"logical_decoding_work_mem"`
		MaintenanceWorkMem            *string `toml:"maintenance_work_mem"`
		MaxConnections                *uint   `toml:"max_connections"`
		MaxLocksPerTransaction        *uint   `toml:"max_locks_per_transaction"`
		MaxParallelMaintenanceWorkers *uint   `toml:"max_parallel_maintenance_workers"`
		MaxParallelWorkers            *uint   `toml:"max_parallel_workers"`
		MaxParallelWorkersPerGather   *uint   `toml:"max_parallel_workers_per_gather"`
		MaxReplicationSlots           *uint   `toml:"max_replication_slots"`
		MaxSlotWalKeepSize            *string `toml:"max_slot_wal_keep_size"`
		MaxStandbyArchiveDelay        *string `toml:"max_standby_archive_delay"`
		MaxStandbyStreamingDelay      *string `toml:"max_standby_streaming_delay"`
		MaxWalSize                    *string `toml:"max_wal_size"`
		MaxWalSenders                 *uint   `toml:"max_wal_senders"`
		MaxWorkerProcesses            *uint   `toml:"max_worker_processes"`
		SessionReplicationRole        *string `toml:"session_replication_role"`
		SharedBuffers                 *string `toml:"shared_buffers"`
		StatementTimeout              *string `toml:"statement_timeout"`
		WalKeepSize                   *string `toml:"wal_keep_size"`
		WalSenderTimeout              *string `toml:"wal_sender_timeout"`
		WorkMem                       *string `toml:"work_mem"`
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

// Compare two pointers values handling the nil case
func isPointerValueEquals[T comparable](a, b *T) bool {
	if a == nil && b == nil {
		return true
	}
	if a == nil || b == nil {
		return false
	}
	return *a == *b
}

// Compare two db config, if changes requires restart return true, return false otherwise
func requireDbRestart(a *db, b *db) bool {
	return !isPointerValueEquals(a.Settings.MaxConnections, b.Settings.MaxConnections) ||
		!isPointerValueEquals(a.Settings.MaxWorkerProcesses, b.Settings.MaxWorkerProcesses) ||
		!isPointerValueEquals(a.Settings.MaxParallelWorkers, b.Settings.MaxParallelWorkers) ||
		!isPointerValueEquals(a.Settings.MaxWalSenders, b.Settings.MaxWalSenders) ||
		!isPointerValueEquals(a.Settings.MaxReplicationSlots, b.Settings.MaxReplicationSlots) ||
		!isPointerValueEquals(a.Settings.SharedBuffers, b.Settings.SharedBuffers)
}

func (a *db) ToUpdatePostgresConfigBody() v1API.UpdatePostgresConfigBody {
	body := v1API.UpdatePostgresConfigBody{}

	// Parameters that require restart
	body.MaxConnections = cast.UintToIntPtr(a.Settings.MaxConnections)
	body.MaxWorkerProcesses = cast.UintToIntPtr(a.Settings.MaxWorkerProcesses)
	body.MaxParallelWorkers = cast.UintToIntPtr(a.Settings.MaxParallelWorkers)
	body.MaxWalSenders = cast.UintToIntPtr(a.Settings.MaxWalSenders)
	body.MaxReplicationSlots = cast.UintToIntPtr(a.Settings.MaxReplicationSlots)
	body.SharedBuffers = a.Settings.SharedBuffers

	// Parameters that can be changed without restart
	body.EffectiveCacheSize = a.Settings.EffectiveCacheSize
	body.LogicalDecodingWorkMem = a.Settings.LogicalDecodingWorkMem
	body.MaintenanceWorkMem = a.Settings.MaintenanceWorkMem
	body.MaxLocksPerTransaction = cast.UintToIntPtr(a.Settings.MaxLocksPerTransaction)
	body.MaxParallelMaintenanceWorkers = cast.UintToIntPtr(a.Settings.MaxParallelMaintenanceWorkers)
	body.MaxParallelWorkersPerGather = cast.UintToIntPtr(a.Settings.MaxParallelWorkersPerGather)
	body.MaxSlotWalKeepSize = a.Settings.MaxSlotWalKeepSize
	body.MaxStandbyArchiveDelay = a.Settings.MaxStandbyArchiveDelay
	body.MaxStandbyStreamingDelay = a.Settings.MaxStandbyStreamingDelay
	body.MaxWalSize = a.Settings.MaxWalSize
	body.SessionReplicationRole = (*v1API.UpdatePostgresConfigBodySessionReplicationRole)(a.Settings.SessionReplicationRole)
	body.StatementTimeout = a.Settings.StatementTimeout
	body.WalKeepSize = a.Settings.WalKeepSize
	body.WalSenderTimeout = a.Settings.WalSenderTimeout
	body.WorkMem = a.Settings.WorkMem
	return body
}

func (a *db) fromRemoteDbConfig(remoteConfig v1API.PostgresConfigResponse) db {
	result := *a

	result.Settings.EffectiveCacheSize = remoteConfig.EffectiveCacheSize
	result.Settings.LogicalDecodingWorkMem = remoteConfig.LogicalDecodingWorkMem
	result.Settings.MaintenanceWorkMem = remoteConfig.MaintenanceWorkMem
	result.Settings.MaxConnections = cast.IntToUintPtr(remoteConfig.MaxConnections)
	result.Settings.MaxLocksPerTransaction = cast.IntToUintPtr(remoteConfig.MaxLocksPerTransaction)
	result.Settings.MaxParallelMaintenanceWorkers = cast.IntToUintPtr(remoteConfig.MaxParallelMaintenanceWorkers)
	result.Settings.MaxParallelWorkers = cast.IntToUintPtr(remoteConfig.MaxParallelWorkers)
	result.Settings.MaxParallelWorkersPerGather = cast.IntToUintPtr(remoteConfig.MaxParallelWorkersPerGather)
	result.Settings.MaxReplicationSlots = cast.IntToUintPtr(remoteConfig.MaxReplicationSlots)
	result.Settings.MaxSlotWalKeepSize = remoteConfig.MaxSlotWalKeepSize
	result.Settings.MaxStandbyArchiveDelay = remoteConfig.MaxStandbyArchiveDelay
	result.Settings.MaxStandbyStreamingDelay = remoteConfig.MaxStandbyStreamingDelay
	result.Settings.MaxWalSenders = cast.IntToUintPtr(remoteConfig.MaxWalSenders)
	result.Settings.MaxWalSize = remoteConfig.MaxWalSize
	result.Settings.MaxWorkerProcesses = cast.IntToUintPtr(remoteConfig.MaxWorkerProcesses)
	result.Settings.SessionReplicationRole = (*string)(remoteConfig.SessionReplicationRole)
	result.Settings.SharedBuffers = remoteConfig.SharedBuffers
	result.Settings.StatementTimeout = remoteConfig.StatementTimeout
	result.Settings.WalKeepSize = remoteConfig.WalKeepSize
	result.Settings.WalSenderTimeout = remoteConfig.WalSenderTimeout
	result.Settings.WorkMem = remoteConfig.WorkMem
	return result
}

func (a *db) DiffWithRemote(remoteConfig v1API.PostgresConfigResponse) ([]byte, error) {
	// Convert the config values into easily comparable remoteConfig values
	currentValue, err := ToTomlBytes(a)
	if err != nil {
		return nil, err
	}
	remoteCompare, err := ToTomlBytes(a.fromRemoteDbConfig(remoteConfig))
	if err != nil {
		return nil, err
	}
	return diff.Diff("remote[db]", remoteCompare, "local[db]", currentValue), nil
}
