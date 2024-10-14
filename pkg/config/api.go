package config

import (
	"strings"

	"github.com/supabase/cli/internal/utils/cast"
	"github.com/supabase/cli/internal/utils/diff"
	v1API "github.com/supabase/cli/pkg/api"
)

type (
	RemoteApi struct {
		Enabled         bool     `toml:"enabled"`
		Schemas         []string `toml:"schemas"`
		ExtraSearchPath []string `toml:"extra_search_path"`
		MaxRows         uint     `toml:"max_rows"`
	}
	api struct {
		RemoteApi
		Image     string  `toml:"-"`
		KongImage string  `toml:"-"`
		Port      uint16  `toml:"port"`
		Tls       tlsKong `toml:"tls"`
		// TODO: replace [auth|studio].api_url
		ExternalUrl string `toml:"external_url"`
	}

	tlsKong struct {
		Enabled bool `toml:"enabled"`
	}
)

func (a *RemoteApi) ToUpdatePostgrestConfigBody() v1API.UpdatePostgrestConfigBody {
	body := v1API.UpdatePostgrestConfigBody{}

	// When the api is disabled, remote side it just set the dbSchema to an empty value
	if !a.Enabled {
		emptyString := ""
		body.DbSchema = &emptyString
		return body
	}

	// Convert Schemas to a comma-separated string
	if len(a.Schemas) > 0 {
		schemas := strings.Join(a.Schemas, ",")
		body.DbSchema = &schemas
	}

	// Convert ExtraSearchPath to a comma-separated string
	if len(a.ExtraSearchPath) > 0 {
		extraSearchPath := strings.Join(a.ExtraSearchPath, ",")
		body.DbExtraSearchPath = &extraSearchPath
	}

	// Convert MaxRows to int pointer
	if a.MaxRows > 0 {
		intValue := cast.UintToInt(a.MaxRows)
		body.MaxRows = &intValue
	}

	// Note: DbPool is not present in the Api struct, so it's not set here
	return body
}

func (a *RemoteApi) fromRemoteApiConfig(remoteConfig v1API.PostgrestConfigWithJWTSecretResponse) RemoteApi {
	result := *a
	if remoteConfig.DbSchema == "" {
		result.Enabled = false
		return result
	}
	result.Enabled = true
	// Update Schemas if present in remoteConfig
	schemas := strings.Split(remoteConfig.DbSchema, ",")
	result.Schemas = make([]string, len(schemas))
	// TODO: use slices.Map when upgrade go version
	for i, schema := range schemas {
		result.Schemas[i] = strings.TrimSpace(schema)
	}

	// Update ExtraSearchPath if present in remoteConfig
	extraSearchPath := strings.Split(remoteConfig.DbExtraSearchPath, ",")
	result.ExtraSearchPath = make([]string, len(extraSearchPath))
	for i, path := range extraSearchPath {
		result.ExtraSearchPath[i] = strings.TrimSpace(path)
	}

	// Update MaxRows if present in remoteConfig
	result.MaxRows = cast.IntToUint(remoteConfig.MaxRows)

	return result
}

func (a *RemoteApi) DiffWithRemote(remoteConfig v1API.PostgrestConfigWithJWTSecretResponse) []byte {
	// Convert the config values into easily comparable remoteConfig values
	currentValue := ToTomlBytes(a)
	remoteCompare := ToTomlBytes(a.fromRemoteApiConfig(remoteConfig))
	return diff.Diff("remote[api]", remoteCompare, "local[api]", currentValue)
}
