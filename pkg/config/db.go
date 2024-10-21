package config

import (
	v1API "github.com/supabase/cli/pkg/api"
	"github.com/supabase/cli/pkg/cast"
	"github.com/supabase/cli/pkg/diff"
)

type (
	PoolMode string

	// All of thoses are remote only settings that'll apply to supabase hosted database
	remoteDb struct {
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
		remoteDb
		Image        string `toml:"-"`
		Port         uint16 `toml:"port"`
		ShadowPort   uint16 `toml:"shadow_port"`
		MajorVersion uint   `toml:"major_version"`
		Password     string `toml:"-"`
		RootKey      string `toml:"-" mapstructure:"root_key"`
		Pooler       pooler `toml:"pooler"`
		Seed         seed   `toml:"seed"`
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

func (a *db) ToUpdatePostgresConfigBody() v1API.UpdatePostgresConfigBody {
	body := v1API.UpdatePostgresConfigBody{}

	body.EffectiveCacheSize = a.EffectiveCacheSize
	body.LogicalDecodingWorkMem = a.LogicalDecodingWorkMem
	body.MaintenanceWorkMem = a.MaintenanceWorkMem
	body.MaxConnections = cast.UintToIntPtr(a.MaxConnections)
	body.MaxLocksPerTransaction = cast.UintToIntPtr(a.MaxLocksPerTransaction)
	body.MaxParallelMaintenanceWorkers = cast.UintToIntPtr(a.MaxParallelMaintenanceWorkers)
	body.MaxParallelWorkers = cast.UintToIntPtr(a.MaxParallelWorkers)
	body.MaxParallelWorkersPerGather = cast.UintToIntPtr(a.MaxParallelWorkersPerGather)
	body.MaxReplicationSlots = cast.UintToIntPtr(a.MaxReplicationSlots)
	body.MaxSlotWalKeepSize = a.MaxSlotWalKeepSize
	body.MaxStandbyArchiveDelay = a.MaxStandbyArchiveDelay
	body.MaxStandbyStreamingDelay = a.MaxStandbyStreamingDelay
	body.MaxWalSenders = cast.UintToIntPtr(a.MaxWalSenders)
	body.MaxWalSize = a.MaxWalSize
	body.MaxWorkerProcesses = cast.UintToIntPtr(a.MaxWorkerProcesses)
	body.SessionReplicationRole = (*v1API.UpdatePostgresConfigBodySessionReplicationRole)(a.SessionReplicationRole)
	body.SharedBuffers = a.SharedBuffers
	body.StatementTimeout = a.StatementTimeout
	body.WalKeepSize = a.WalKeepSize
	body.WalSenderTimeout = a.WalSenderTimeout
	body.WorkMem = a.WorkMem
	return body
}

func (a *db) fromRemoteApiConfig(remoteConfig v1API.PostgresConfigResponse) db {
	result := *a

	result.remoteDb.EffectiveCacheSize = remoteConfig.EffectiveCacheSize
	result.remoteDb.LogicalDecodingWorkMem = remoteConfig.LogicalDecodingWorkMem
	result.remoteDb.MaintenanceWorkMem = remoteConfig.MaintenanceWorkMem
	result.remoteDb.MaxConnections = cast.IntToUintPtr(remoteConfig.MaxConnections)
	result.remoteDb.MaxLocksPerTransaction = cast.IntToUintPtr(remoteConfig.MaxLocksPerTransaction)
	result.remoteDb.MaxParallelMaintenanceWorkers = cast.IntToUintPtr(remoteConfig.MaxParallelMaintenanceWorkers)
	result.remoteDb.MaxParallelWorkers = cast.IntToUintPtr(remoteConfig.MaxParallelWorkers)
	result.remoteDb.MaxParallelWorkersPerGather = cast.IntToUintPtr(remoteConfig.MaxParallelWorkersPerGather)
	result.remoteDb.MaxReplicationSlots = cast.IntToUintPtr(remoteConfig.MaxReplicationSlots)
	result.remoteDb.MaxSlotWalKeepSize = remoteConfig.MaxSlotWalKeepSize
	result.remoteDb.MaxStandbyArchiveDelay = remoteConfig.MaxStandbyArchiveDelay
	result.remoteDb.MaxStandbyStreamingDelay = remoteConfig.MaxStandbyStreamingDelay
	result.remoteDb.MaxWalSenders = cast.IntToUintPtr(remoteConfig.MaxWalSenders)
	result.remoteDb.MaxWalSize = remoteConfig.MaxWalSize
	result.remoteDb.MaxWorkerProcesses = cast.IntToUintPtr(remoteConfig.MaxWorkerProcesses)
	result.remoteDb.SessionReplicationRole = (*string)(remoteConfig.SessionReplicationRole)
	result.remoteDb.SharedBuffers = remoteConfig.SharedBuffers
	result.remoteDb.StatementTimeout = remoteConfig.StatementTimeout
	result.remoteDb.WalKeepSize = remoteConfig.WalKeepSize
	result.remoteDb.WalSenderTimeout = remoteConfig.WalSenderTimeout
	result.remoteDb.WorkMem = remoteConfig.WorkMem
	return result
}

func (a *db) DiffWithRemote(remoteConfig v1API.PostgresConfigResponse) ([]byte, error) {
	// Convert the config values into easily comparable remoteConfig values
	currentValue, err := ToTomlBytes(a)
	if err != nil {
		return nil, err
	}
	remoteCompare, err := ToTomlBytes(a.fromRemoteApiConfig(remoteConfig))
	if err != nil {
		return nil, err
	}
	return diff.Diff("remote[db]", remoteCompare, "local[db]", currentValue), nil
}
