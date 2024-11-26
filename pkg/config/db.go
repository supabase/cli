package config

import (
	"bytes"

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
		TrackCommitTimestamp          *bool                   `toml:"track_commit_timestamp"`
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
	body.TrackCommitTimestamp = a.TrackCommitTimestamp
	body.WalKeepSize = a.WalKeepSize
	body.WalSenderTimeout = a.WalSenderTimeout
	body.WorkMem = a.WorkMem
	return body
}

func (a *settings) FromRemotePostgresConfig(remoteConfig v1API.PostgresConfigResponse) {
	a.EffectiveCacheSize = remoteConfig.EffectiveCacheSize
	a.LogicalDecodingWorkMem = remoteConfig.LogicalDecodingWorkMem
	a.MaintenanceWorkMem = remoteConfig.MaintenanceWorkMem
	a.MaxConnections = cast.IntToUintPtr(remoteConfig.MaxConnections)
	a.MaxLocksPerTransaction = cast.IntToUintPtr(remoteConfig.MaxLocksPerTransaction)
	a.MaxParallelMaintenanceWorkers = cast.IntToUintPtr(remoteConfig.MaxParallelMaintenanceWorkers)
	a.MaxParallelWorkers = cast.IntToUintPtr(remoteConfig.MaxParallelWorkers)
	a.MaxParallelWorkersPerGather = cast.IntToUintPtr(remoteConfig.MaxParallelWorkersPerGather)
	a.MaxReplicationSlots = cast.IntToUintPtr(remoteConfig.MaxReplicationSlots)
	a.MaxSlotWalKeepSize = remoteConfig.MaxSlotWalKeepSize
	a.MaxStandbyArchiveDelay = remoteConfig.MaxStandbyArchiveDelay
	a.MaxStandbyStreamingDelay = remoteConfig.MaxStandbyStreamingDelay
	a.MaxWalSenders = cast.IntToUintPtr(remoteConfig.MaxWalSenders)
	a.MaxWalSize = remoteConfig.MaxWalSize
	a.MaxWorkerProcesses = cast.IntToUintPtr(remoteConfig.MaxWorkerProcesses)
	a.SessionReplicationRole = (*SessionReplicationRole)(remoteConfig.SessionReplicationRole)
	a.SharedBuffers = remoteConfig.SharedBuffers
	a.StatementTimeout = remoteConfig.StatementTimeout
	a.TrackCommitTimestamp = remoteConfig.TrackCommitTimestamp
	a.WalKeepSize = remoteConfig.WalKeepSize
	a.WalSenderTimeout = remoteConfig.WalSenderTimeout
	a.WorkMem = remoteConfig.WorkMem
}

const pgConfHeader = "\n# supabase [db.settings] configuration\n"

// create a valid string to append to /etc/postgresql/postgresql.conf
func (a *settings) ToPostgresConfig() string {
	// Assuming postgres settings is always a flat struct, we can serialise
	// using toml, then replace double quotes with single.
	data, _ := ToTomlBytes(*a)
	body := bytes.ReplaceAll(data, []byte{'"'}, []byte{'\''})
	return pgConfHeader + string(body)
}

func (a *settings) DiffWithRemote(remoteConfig v1API.PostgresConfigResponse) ([]byte, error) {
	copy := *a
	// Convert the config values into easily comparable remoteConfig values
	currentValue, err := ToTomlBytes(copy)
	if err != nil {
		return nil, err
	}
	copy.FromRemotePostgresConfig(remoteConfig)
	remoteCompare, err := ToTomlBytes(copy)
	if err != nil {
		return nil, err
	}
	return diff.Diff("remote[db.settings]", remoteCompare, "local[db.settings]", currentValue), nil
}
