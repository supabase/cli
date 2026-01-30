package config

import (
	"bytes"
	"slices"
	"time"

	"github.com/go-errors/errors"
	v1API "github.com/supabase/cli/pkg/api"
	"github.com/supabase/cli/pkg/cast"
	"github.com/supabase/cli/pkg/diff"
)

type PoolMode string

const (
	TransactionMode PoolMode = "transaction"
	SessionMode     PoolMode = "session"
)

func (m *PoolMode) UnmarshalText(text []byte) error {
	allowed := []PoolMode{TransactionMode, SessionMode}
	if *m = PoolMode(text); !slices.Contains(allowed, *m) {
		return errors.Errorf("must be one of %v", allowed)
	}
	return nil
}

type SessionReplicationRole string

const (
	SessionReplicationRoleOrigin  SessionReplicationRole = "origin"
	SessionReplicationRoleReplica SessionReplicationRole = "replica"
	SessionReplicationRoleLocal   SessionReplicationRole = "local"
)

func (r *SessionReplicationRole) UnmarshalText(text []byte) error {
	allowed := []SessionReplicationRole{SessionReplicationRoleOrigin, SessionReplicationRoleReplica, SessionReplicationRoleLocal}
	if *r = SessionReplicationRole(text); !slices.Contains(allowed, *r) {
		return errors.Errorf("must be one of %v", allowed)
	}
	return nil
}

type (
	settings struct {
		EffectiveCacheSize            *string                 `json:"effective_cache_size"`
		LogicalDecodingWorkMem        *string                 `json:"logical_decoding_work_mem"`
		MaintenanceWorkMem            *string                 `json:"maintenance_work_mem"`
		MaxConnections                *uint                   `json:"max_connections"`
		MaxLocksPerTransaction        *uint                   `json:"max_locks_per_transaction"`
		MaxParallelMaintenanceWorkers *uint                   `json:"max_parallel_maintenance_workers"`
		MaxParallelWorkers            *uint                   `json:"max_parallel_workers"`
		MaxParallelWorkersPerGather   *uint                   `json:"max_parallel_workers_per_gather"`
		MaxReplicationSlots           *uint                   `json:"max_replication_slots"`
		MaxSlotWalKeepSize            *string                 `json:"max_slot_wal_keep_size"`
		MaxStandbyArchiveDelay        *string                 `json:"max_standby_archive_delay"`
		MaxStandbyStreamingDelay      *string                 `json:"max_standby_streaming_delay"`
		MaxWalSize                    *string                 `json:"max_wal_size"`
		MaxWalSenders                 *uint                   `json:"max_wal_senders"`
		MaxWorkerProcesses            *uint                   `json:"max_worker_processes"`
		SessionReplicationRole        *SessionReplicationRole `json:"session_replication_role"`
		SharedBuffers                 *string                 `json:"shared_buffers"`
		StatementTimeout              *string                 `json:"statement_timeout"`
		TrackActivityQuerySize        *string                 `json:"track_activity_query_size"`
		TrackCommitTimestamp          *bool                   `json:"track_commit_timestamp"`
		WalKeepSize                   *string                 `json:"wal_keep_size"`
		WalSenderTimeout              *string                 `json:"wal_sender_timeout"`
		WorkMem                       *string                 `json:"work_mem"`
	}

	networkRestrictions struct {
		Enabled        bool     `json:"enabled"`
		AllowedCidrs   []string `json:"allowed_cidrs"`
		AllowedCidrsV6 []string `json:"allowed_cidrs_v6"`
	}

	db struct {
		Image               string              `json:"-"`
		Port                uint16              `json:"port"`
		ShadowPort          uint16              `json:"shadow_port"`
		HealthTimeout       time.Duration       `json:"health_timeout"`
		MajorVersion        uint                `json:"major_version"`
		Password            string              `json:"-"`
		RootKey             Secret              `json:"root_key"`
		Pooler              pooler              `json:"pooler"`
		Migrations          migrations          `json:"migrations"`
		Seed                seed                `json:"seed"`
		Settings            settings            `json:"settings"`
		NetworkRestrictions networkRestrictions `json:"network_restrictions"`
		Vault               map[string]Secret   `json:"vault"`
	}

	migrations struct {
		Enabled     bool `json:"enabled"`
		SchemaPaths Glob `json:"schema_paths"`
	}

	seed struct {
		Enabled  bool `json:"enabled"`
		SqlPaths Glob `json:"sql_paths"`
	}

	pooler struct {
		Enabled          bool     `json:"enabled"`
		Image            string   `json:"-"`
		Port             uint16   `json:"port"`
		PoolMode         PoolMode `json:"pool_mode"`
		DefaultPoolSize  uint     `json:"default_pool_size"`
		MaxClientConn    uint     `json:"max_client_conn"`
		ConnectionString string   `json:"-"`
		TenantId         string   `json:"-"`
		EncryptionKey    string   `json:"-"`
		SecretKeyBase    string   `json:"-"`
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
	body.TrackActivityQuerySize = a.TrackActivityQuerySize
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
	a.TrackActivityQuerySize = remoteConfig.TrackActivityQuerySize
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

func (n networkRestrictions) ToUpdateNetworkRestrictionsBody() v1API.V1UpdateNetworkRestrictionsJSONRequestBody {
	body := v1API.V1UpdateNetworkRestrictionsJSONRequestBody{
		DbAllowedCidrs:   &n.AllowedCidrs,
		DbAllowedCidrsV6: &n.AllowedCidrsV6,
	}
	return body
}

func (n *networkRestrictions) FromRemoteNetworkRestrictions(remoteConfig v1API.NetworkRestrictionsResponse) {
	if !n.Enabled {
		return
	}
	if remoteConfig.Config.DbAllowedCidrs != nil {
		n.AllowedCidrs = *remoteConfig.Config.DbAllowedCidrs
	}
	if remoteConfig.Config.DbAllowedCidrsV6 != nil {
		n.AllowedCidrsV6 = *remoteConfig.Config.DbAllowedCidrsV6
	}
}

func (n *networkRestrictions) DiffWithRemote(remoteConfig v1API.NetworkRestrictionsResponse) ([]byte, error) {
	copy := *n
	// Convert the config values into easily comparable remoteConfig values
	currentValue, err := ToTomlBytes(copy)
	if err != nil {
		return nil, err
	}
	copy.FromRemoteNetworkRestrictions(remoteConfig)
	remoteCompare, err := ToTomlBytes(copy)
	if err != nil {
		return nil, err
	}
	return diff.Diff("remote[db.network_restrictions]", remoteCompare, "local[db.network_restrictions]", currentValue), nil
}
