package utils

import (
	"path/filepath"

	"github.com/spf13/afero"
)

type ProjectPaths struct {
	SupabaseDirPath       string
	ConfigPath            string
	GitIgnorePath         string
	TempDir               string
	ImportMapsDir         string
	ProjectRefPath        string
	PoolerUrlPath         string
	PostgresVersionPath   string
	GotrueVersionPath     string
	RestVersionPath       string
	StorageVersionPath    string
	StorageMigrationPath  string
	StudioVersionPath     string
	PgmetaVersionPath     string
	PoolerVersionPath     string
	RealtimeVersionPath   string
	CliVersionPath        string
	ProfilePath           string
	CurrBranchPath        string
	ClusterDir            string
	SchemasDir            string
	MigrationsDir         string
	FunctionsDir          string
	SnippetsDir           string
	FallbackImportMapPath string
	FallbackEnvFilePath   string
	DbTestsDir            string
	CustomRolesPath       string
}

var Paths = DefaultPaths("supabase")

func DefaultPaths(base string) ProjectPaths {
	if len(base) == 0 {
		base = "supabase"
	}
	tempDir := filepath.Join(base, ".temp")
	functionsDir := filepath.Join(base, "functions")
	return ProjectPaths{
		SupabaseDirPath:       base,
		ConfigPath:            filepath.Join(base, "config.toml"),
		GitIgnorePath:         filepath.Join(base, ".gitignore"),
		TempDir:               tempDir,
		ImportMapsDir:         filepath.Join(tempDir, "import_maps"),
		ProjectRefPath:        filepath.Join(tempDir, "project-ref"),
		PoolerUrlPath:         filepath.Join(tempDir, "pooler-url"),
		PostgresVersionPath:   filepath.Join(tempDir, "postgres-version"),
		GotrueVersionPath:     filepath.Join(tempDir, "gotrue-version"),
		RestVersionPath:       filepath.Join(tempDir, "rest-version"),
		StorageVersionPath:    filepath.Join(tempDir, "storage-version"),
		StorageMigrationPath:  filepath.Join(tempDir, "storage-migration"),
		StudioVersionPath:     filepath.Join(tempDir, "studio-version"),
		PgmetaVersionPath:     filepath.Join(tempDir, "pgmeta-version"),
		PoolerVersionPath:     filepath.Join(tempDir, "pooler-version"),
		RealtimeVersionPath:   filepath.Join(tempDir, "realtime-version"),
		CliVersionPath:        filepath.Join(tempDir, "cli-latest"),
		ProfilePath:           filepath.Join(tempDir, "profile"),
		CurrBranchPath:        filepath.Join(base, ".branches", "_current_branch"),
		ClusterDir:            filepath.Join(base, "cluster"),
		SchemasDir:            filepath.Join(base, "schemas"),
		MigrationsDir:         filepath.Join(base, "migrations"),
		FunctionsDir:          functionsDir,
		SnippetsDir:           filepath.Join(base, "snippets"),
		FallbackImportMapPath: filepath.Join(functionsDir, "import_map.json"),
		FallbackEnvFilePath:   filepath.Join(functionsDir, ".env"),
		DbTestsDir:            filepath.Join(base, "tests"),
		CustomRolesPath:       filepath.Join(base, "roles.sql"),
	}
}

func ResolveProjectPaths(fsys afero.Fs) (ProjectPaths, error) {
	if ok, err := afero.Exists(fsys, filepath.Join("supabase", "config.toml")); err != nil {
		return ProjectPaths{}, err
	} else if ok {
		return DefaultPaths("supabase"), nil
	}
	if ok, err := afero.Exists(fsys, "config.toml"); err != nil {
		return ProjectPaths{}, err
	} else if ok {
		return DefaultPaths("."), nil
	}
	return DefaultPaths("supabase"), nil
}
