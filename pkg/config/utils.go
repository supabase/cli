package config

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"path/filepath"
	"strings"
)

type pathBuilder struct {
	SupabaseDirPath        string
	ConfigPath             string
	GitIgnorePath          string
	TempDir                string
	ImportMapsDir          string
	ProjectRefPath         string
	PoolerUrlPath          string
	PostgresVersionPath    string
	GotrueVersionPath      string
	RestVersionPath        string
	StorageVersionPath     string
	StudioVersionPath      string
	PgmetaVersionPath      string
	PoolerVersionPath      string
	RealtimeVersionPath    string
	EdgeRuntimeVersionPath string
	CliVersionPath         string
	CurrBranchPath         string
	SchemasDir             string
	MigrationsDir          string
	FunctionsDir           string
	FallbackImportMapPath  string
	FallbackEnvFilePath    string
	DbTestsDir             string
	CustomRolesPath        string
}

func NewPathBuilder(configPath string) pathBuilder {
	if filepath.Base(configPath) == "." {
		configPath = filepath.Join("supabase", "config.toml")
	}
	// TODO: make base path configurable from toml
	base := filepath.Dir(configPath)
	return pathBuilder{
		SupabaseDirPath:        base,
		ConfigPath:             configPath,
		GitIgnorePath:          filepath.Join(base, ".gitignore"),
		TempDir:                filepath.Join(base, ".temp"),
		ImportMapsDir:          filepath.Join(base, ".temp", "import_maps"),
		ProjectRefPath:         filepath.Join(base, ".temp", "project-ref"),
		PoolerUrlPath:          filepath.Join(base, ".temp", "pooler-url"),
		PostgresVersionPath:    filepath.Join(base, ".temp", "postgres-version"),
		GotrueVersionPath:      filepath.Join(base, ".temp", "gotrue-version"),
		RestVersionPath:        filepath.Join(base, ".temp", "rest-version"),
		StorageVersionPath:     filepath.Join(base, ".temp", "storage-version"),
		EdgeRuntimeVersionPath: filepath.Join(base, ".temp", "edge-runtime-version"),
		StudioVersionPath:      filepath.Join(base, ".temp", "studio-version"),
		PgmetaVersionPath:      filepath.Join(base, ".temp", "pgmeta-version"),
		PoolerVersionPath:      filepath.Join(base, ".temp", "pooler-version"),
		RealtimeVersionPath:    filepath.Join(base, ".temp", "realtime-version"),
		CliVersionPath:         filepath.Join(base, ".temp", "cli-latest"),
		CurrBranchPath:         filepath.Join(base, ".branches", "_current_branch"),
		SchemasDir:             filepath.Join(base, "schemas"),
		MigrationsDir:          filepath.Join(base, "migrations"),
		FunctionsDir:           filepath.Join(base, "functions"),
		FallbackImportMapPath:  filepath.Join(base, "functions", "import_map.json"),
		FallbackEnvFilePath:    filepath.Join(base, "functions", ".env"),
		DbTestsDir:             filepath.Join(base, "tests"),
		CustomRolesPath:        filepath.Join(base, "roles.sql"),
	}
}

func sliceContains[T comparable](s []T, e T) bool {
	for _, a := range s {
		if a == e {
			return true
		}
	}
	return false
}

func replaceImageTag(image string, tag string) string {
	index := strings.IndexByte(image, ':')
	return image[:index+1] + strings.TrimSpace(tag)
}

func strToArr(v string) []string {
	// Avoid returning [""] if v is empty
	if len(v) == 0 {
		return []string{}
	}
	return strings.Split(v, ",")
}

func mapToEnv(input map[string]string) string {
	var result []string
	for k, v := range input {
		kv := fmt.Sprintf("%s=%s", k, v)
		result = append(result, kv)
	}
	return strings.Join(result, ",")
}

func envToMap(input string) map[string]string {
	env := strToArr(input)
	result := make(map[string]string, len(env))
	for _, kv := range env {
		if parts := strings.Split(kv, "="); len(parts) > 1 {
			result[parts[0]] = parts[1]
		}
	}
	return result
}

func sha256Hmac(key, value string) string {
	h := hmac.New(sha256.New, []byte(key))
	h.Write([]byte(value))
	return hex.EncodeToString(h.Sum(nil))
}
