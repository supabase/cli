package config

import (
	"strings"

	v1API "github.com/supabase/cli/pkg/api"
)

type (
	RemoteApi struct {
		Schemas         []string `toml:"schemas"`
		ExtraSearchPath []string `toml:"extra_search_path"`
		MaxRows         uint     `toml:"max_rows"`
	}
	api struct {
		RemoteApi
		Enabled   bool    `toml:"enabled"`
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
		maxRows := int(a.MaxRows)
		body.MaxRows = &maxRows
	}

	// Note: DbPool is not present in the Api struct, so it's not set here
	return body
}

func (a *RemoteApi) fromRemoteApiConfig(remoteConfig v1API.PostgrestConfigWithJWTSecretResponse) RemoteApi {
	result := *a
	// Update Schemas if present in remoteConfig
	result.Schemas = strings.Split(remoteConfig.DbSchema, ",")

	// Update ExtraSearchPath if present in remoteConfig
	result.ExtraSearchPath = strings.Split(remoteConfig.DbExtraSearchPath, ",")

	// Update MaxRows if present in remoteConfig
	result.MaxRows = uint(remoteConfig.MaxRows)

	return result
}

func (a *RemoteApi) DiffWithRemote(remoteConfig v1API.PostgrestConfigWithJWTSecretResponse) []byte {
	// Convert the config values into easily comparable remoteConfig values
	currentValue := ToTomlBytes(a)
	remoteCompare := ToTomlBytes(a.fromRemoteApiConfig(remoteConfig))
	return Diff("remote[api]", remoteCompare, "local[api]", currentValue)
}
