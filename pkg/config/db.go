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
		EffectiveCacheSize            *string                 `toml:"effective_cache_size" json:"effective_cache_size"`
		LogicalDecodingWorkMem        *string                 `toml:"logical_decoding_work_mem" json:"logical_decoding_work_mem"`
		MaintenanceWorkMem            *string                 `toml:"maintenance_work_mem" json:"maintenance_work_mem"`
		MaxConnections                *uint                   `toml:"max_connections" json:"max_connections"`
		MaxLocksPerTransaction        *uint                   `toml:"max_locks_per_transaction" json:"max_locks_per_transaction"`
		MaxParallelMaintenanceWorkers *uint                   `toml:"max_parallel_maintenance_workers" json:"max_parallel_maintenance_workers"`
		MaxParallelWorkers            *uint                   `toml:"max_parallel_workers" json:"max_parallel_workers"`
		MaxParallelWorkersPerGather   *uint                   `toml:"max_parallel_workers_per_gather" json:"max_parallel_workers_per_gather"`
		MaxReplicationSlots           *uint                   `toml:"max_replication_slots" json:"max_replication_slots"`
		MaxSlotWalKeepSize            *string                 `toml:"max_slot_wal_keep_size" json:"max_slot_wal_keep_size"`
		MaxStandbyArchiveDelay        *string                 `toml:"max_standby_archive_delay" json:"max_standby_archive_delay"`
		MaxStandbyStreamingDelay      *string                 `toml:"max_standby_streaming_delay" json:"max_standby_streaming_delay"`
		MaxWalSize                    *string                 `toml:"max_wal_size" json:"max_wal_size"`
		MaxWalSenders                 *uint                   `toml:"max_wal_senders" json:"max_wal_senders"`
		MaxWorkerProcesses            *uint                   `toml:"max_worker_processes" json:"max_worker_processes"`
		SessionReplicationRole        *SessionReplicationRole `toml:"session_replication_role" json:"session_replication_role"`
		SharedBuffers                 *string                 `toml:"shared_buffers" json:"shared_buffers"`
		StatementTimeout              *string                 `toml:"statement_timeout" json:"statement_timeout"`
		TrackActivityQuerySize        *string                 `toml:"track_activity_query_size" json:"track_activity_query_size"`
		TrackCommitTimestamp          *bool                   `toml:"track_commit_timestamp" json:"track_commit_timestamp"`
		WalKeepSize                   *string                 `toml:"wal_keep_size" json:"wal_keep_size"`
		WalSenderTimeout              *string                 `toml:"wal_sender_timeout" json:"wal_sender_timeout"`
		WorkMem                       *string                 `toml:"work_mem" json:"work_mem"`
	}

	networkRestrictions struct {
		Enabled        bool     `toml:"enabled" json:"enabled"`
		AllowedCidrs   []string `toml:"allowed_cidrs" json:"allowed_cidrs"`
		AllowedCidrsV6 []string `toml:"allowed_cidrs_v6" json:"allowed_cidrs_v6"`
	}

	sslEnforcement struct {
		Enabled bool `toml:"enabled" json:"enabled"`
	}

	db struct {
		Image               string              `toml:"-" json:"-"`
		Port                uint16              `toml:"port" json:"port"`
		ShadowPort          uint16              `toml:"shadow_port" json:"shadow_port"`
		HealthTimeout       time.Duration       `toml:"health_timeout" json:"health_timeout"`
		MajorVersion        uint                `toml:"major_version" json:"major_version"`
		Password            string              `toml:"-" json:"-"`
		RootKey             Secret              `toml:"root_key" json:"root_key"`
		Pooler              pooler              `toml:"pooler" json:"pooler"`
		Migrations          migrations          `toml:"migrations" json:"migrations"`
		Seed                seed                `toml:"seed" json:"seed"`
		Settings            settings            `toml:"settings" json:"settings"`
		NetworkRestrictions networkRestrictions `toml:"network_restrictions" json:"network_restrictions"`
    SslEnforcement      *sslEnforcement     `toml:"ssl_enforcement" json:"ssl_enforcement"`
		Vault               map[string]Secret   `toml:"vault" json:"vault"`
	}

	migrations struct {
		Enabled     bool `toml:"enabled" json:"enabled"`
		SchemaPaths Glob `toml:"schema_paths" json:"schema_paths"`
	}

	seed struct {
		Enabled  bool `toml:"enabled" json:"enabled"`
		SqlPaths Glob `toml:"sql_paths" json:"sql_paths"`
	}

	pooler struct {
		Enabled          bool     `toml:"enabled" json:"enabled"`
		Image            string   `toml:"-" json:"-"`
		Port             uint16   `toml:"port" json:"port"`
		PoolMode         PoolMode `toml:"pool_mode" json:"pool_mode"`
		DefaultPoolSize  uint     `toml:"default_pool_size" json:"default_pool_size"`
		MaxClientConn    uint     `toml:"max_client_conn" json:"max_client_conn"`
		ConnectionString string   `toml:"-" json:"-"`
		TenantId         string   `toml:"-" json:"-"`
		EncryptionKey    string   `toml:"-" json:"-"`
		SecretKeyBase    string   `toml:"-" json:"-"`
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

func (s sslEnforcement) ToUpdateSslEnforcementBody() v1API.V1UpdateSslEnforcementConfigJSONRequestBody {
	body := v1API.V1UpdateSslEnforcementConfigJSONRequestBody{}
	body.RequestedConfig.Database = s.Enabled
	return body
}

func (s *sslEnforcement) FromRemoteSslEnforcement(remoteConfig v1API.SslEnforcementResponse) {
	if s == nil {
		return
	}
	s.Enabled = remoteConfig.CurrentConfig.Database
}

func (s *sslEnforcement) DiffWithRemote(remoteConfig v1API.SslEnforcementResponse) ([]byte, error) {
	copy := *s
	// Convert the config values into easily comparable remoteConfig values
	currentValue, err := ToTomlBytes(copy)
	if err != nil {
		return nil, err
	}
	copy.FromRemoteSslEnforcement(remoteConfig)
	remoteCompare, err := ToTomlBytes(copy)
	if err != nil {
		return nil, err
	}
	return diff.Diff("remote[db.ssl_enforcement]", remoteCompare, "local[db.ssl_enforcement]", currentValue), nil
}
