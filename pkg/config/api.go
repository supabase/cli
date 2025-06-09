package config

import (
	"strings"

	v1API "github.com/supabase/cli/pkg/api"
	"github.com/supabase/cli/pkg/cast"
	"github.com/supabase/cli/pkg/diff"
)

type (
	api struct {
		Enabled         bool     `toml:"enabled"`
		Schemas         []string `toml:"schemas"`
		ExtraSearchPath []string `toml:"extra_search_path"`
		MaxRows         uint     `toml:"max_rows"`
		// Local only config
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

func (a *api) ToUpdatePostgrestConfigBody() v1API.V1UpdatePostgrestConfigBody {
	body := v1API.V1UpdatePostgrestConfigBody{}

	// When the api is disabled, remote side it just set the dbSchema to an empty value
	if !a.Enabled {
		body.DbSchema = cast.Ptr("")
		return body
	}

	// Convert Schemas to a comma-separated string
	if len(a.Schemas) > 0 {
		schemas := strings.Join(a.Schemas, ",")
		body.DbSchema = &schemas
	}

	// Convert ExtraSearchPath to a comma-separated string
	body.DbExtraSearchPath = cast.Ptr(strings.Join(a.ExtraSearchPath, ","))

	// Convert MaxRows to int pointer
	if a.MaxRows > 0 {
		body.MaxRows = cast.Ptr(cast.UintToInt(a.MaxRows))
	}

	// Note: DbPool is not present in the Api struct, so it's not set here
	return body
}

func (a *api) FromRemoteApiConfig(remoteConfig v1API.PostgrestConfigWithJWTSecretResponse) {
	if a.Enabled = len(remoteConfig.DbSchema) > 0; !a.Enabled {
		return
	}

	// Update Schemas if present in remoteConfig
	a.Schemas = strToArr(remoteConfig.DbSchema)
	// TODO: use slices.Map when upgrade go version
	for i, schema := range a.Schemas {
		a.Schemas[i] = strings.TrimSpace(schema)
	}

	// Update ExtraSearchPath if present in remoteConfig
	a.ExtraSearchPath = strToArr(remoteConfig.DbExtraSearchPath)
	for i, path := range a.ExtraSearchPath {
		a.ExtraSearchPath[i] = strings.TrimSpace(path)
	}

	// Update MaxRows if present in remoteConfig
	a.MaxRows = cast.IntToUint(remoteConfig.MaxRows)
}

func (a *api) DiffWithRemote(remoteConfig v1API.PostgrestConfigWithJWTSecretResponse) ([]byte, error) {
	copy := *a
	// Convert the config values into easily comparable remoteConfig values
	currentValue, err := ToTomlBytes(copy)
	if err != nil {
		return nil, err
	}
	copy.FromRemoteApiConfig(remoteConfig)
	remoteCompare, err := ToTomlBytes(copy)
	if err != nil {
		return nil, err
	}
	return diff.Diff("remote[api]", remoteCompare, "local[api]", currentValue), nil
}
