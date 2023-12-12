package utils

import (
	"bytes"
	"context"
	_ "embed"
	"os"
	"path/filepath"
	"regexp"
	"time"

	"github.com/docker/docker/client"
	"github.com/go-errors/errors"
	"github.com/go-git/go-git/v5"
	"github.com/spf13/afero"
)

// Assigned using `-ldflags` https://stackoverflow.com/q/11354518
var (
	Version   string
	SentryDsn string
)

const (
	Pg13Image = "supabase/postgres:13.3.0"
	Pg14Image = "supabase/postgres:14.1.0.89"
	Pg15Image = "supabase/postgres:15.1.0.147"
	// Append to ServiceImages when adding new dependencies below
	KongImage        = "library/kong:2.8.1"
	InbucketImage    = "inbucket/inbucket:3.0.3"
	PostgrestImage   = "postgrest/postgrest:v11.2.2"
	DifferImage      = "supabase/pgadmin-schema-diff:cli-0.0.5"
	MigraImage       = "djrobstep/migra:3.0.1621480950"
	PgmetaImage      = "supabase/postgres-meta:v0.75.0"
	StudioImage      = "supabase/studio:20231123-64a766a"
	ImageProxyImage  = "darthsim/imgproxy:v3.8.0"
	EdgeRuntimeImage = "supabase/edge-runtime:v1.29.1"
	VectorImage      = "timberio/vector:0.28.1-alpine"
	PgbouncerImage   = "bitnami/pgbouncer:1.20.1-debian-11-r39"
	GotrueImage      = "supabase/gotrue:v2.125.1"
	RealtimeImage    = "supabase/realtime:v2.25.35"
	StorageImage     = "supabase/storage-api:v0.43.11"
	LogflareImage    = "supabase/logflare:1.4.0"
	// Should be kept in-sync with EdgeRuntimeImage
	DenoVersion = "1.30.3"
)

var ServiceImages = []string{
	GotrueImage,
	RealtimeImage,
	StorageImage,
	ImageProxyImage,
	KongImage,
	InbucketImage,
	PostgrestImage,
	DifferImage,
	MigraImage,
	PgmetaImage,
	StudioImage,
	EdgeRuntimeImage,
	LogflareImage,
	VectorImage,
	PgbouncerImage,
}

func ShortContainerImageName(imageName string) string {
	matches := ImageNamePattern.FindStringSubmatch(imageName)
	if len(matches) < 2 {
		return imageName
	}
	return matches[1]
}

const (
	// https://dba.stackexchange.com/a/11895
	// Args: dbname
	TerminateDbSqlFmt = `
SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '%[1]s';
-- Wait for WAL sender to drop replication slot.
DO 'BEGIN WHILE (
	SELECT COUNT(*) FROM pg_replication_slots WHERE database = ''%[1]s''
) > 0 LOOP END LOOP; END';`
	SuggestDebugFlag = "Try rerunning the command with --debug to troubleshoot the error."
)

var (
	CmdSuggestion string

	// pg_dumpall --globals-only --no-role-passwords --dbname $DB_URL \
	// | sed '/^CREATE ROLE postgres;/d' \
	// | sed '/^ALTER ROLE postgres WITH /d' \
	// | sed "/^ALTER ROLE .* WITH .* LOGIN /s/;$/ PASSWORD 'postgres';/"
	//go:embed templates/globals.sql
	GlobalsSql string

	ProjectRefPattern  = regexp.MustCompile(`^[a-z]{20}$`)
	UUIDPattern        = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)
	ProjectHostPattern = regexp.MustCompile(`^(db\.)[a-z]{20}\.supabase\.(co|red)$`)
	MigrateFilePattern = regexp.MustCompile(`^([0-9]+)_(.*)\.sql$`)
	BranchNamePattern  = regexp.MustCompile(`[[:word:]-]+`)
	FuncSlugPattern    = regexp.MustCompile(`^[A-Za-z][A-Za-z0-9_-]*$`)
	ImageNamePattern   = regexp.MustCompile(`\/(.*):`)

	// These schemas are ignored from db diff and db dump
	SystemSchemas = []string{
		"information_schema",
		"pg_*", // Wildcard pattern follows pg_dump
		// Owned by extensions
		"cron",
		"graphql",
		"graphql_public",
		"net",
		"pgsodium",
		"pgsodium_masks",
		"pgtle",
		"repack",
		"tiger",
		"tiger_data",
		"timescaledb_*",
		"_timescaledb_*",
		"topology",
		"vault",
	}
	InternalSchemas = append([]string{
		"auth",
		"extensions",
		"pgbouncer",
		"realtime",
		"_realtime",
		"storage",
		"_analytics",
		"supabase_functions",
		"supabase_migrations",
	}, SystemSchemas...)
	ReservedRoles = []string{
		"anon",
		"authenticated",
		"authenticator",
		"dashboard_user",
		"pgbouncer",
		"postgres",
		"service_role",
		"supabase_admin",
		"supabase_auth_admin",
		"supabase_functions_admin",
		"supabase_read_only_user",
		"supabase_replication_admin",
		"supabase_storage_admin",
		// Managed by extensions
		"pgsodium_keyholder",
		"pgsodium_keyiduser",
		"pgsodium_keymaker",
		"pgtle_admin",
	}
	AllowedConfigs = []string{
		// Ref: https://github.com/supabase/postgres/blob/develop/ansible/files/postgresql_config/supautils.conf.j2#L10
		"pgaudit.*",
		"pgrst.*",
		"session_replication_role",
		"statement_timeout",
		"track_io_timing",
	}

	SupabaseDirPath       = "supabase"
	ConfigPath            = filepath.Join(SupabaseDirPath, "config.toml")
	GitIgnorePath         = filepath.Join(SupabaseDirPath, ".gitignore")
	TempDir               = filepath.Join(SupabaseDirPath, ".temp")
	ImportMapsDir         = filepath.Join(TempDir, "import_maps")
	ProjectRefPath        = filepath.Join(TempDir, "project-ref")
	RemoteDbPath          = filepath.Join(TempDir, "remote-db-url")
	PostgresVersionPath   = filepath.Join(TempDir, "postgres-version")
	GotrueVersionPath     = filepath.Join(TempDir, "gotrue-version")
	RestVersionPath       = filepath.Join(TempDir, "rest-version")
	StorageVersionPath    = filepath.Join(TempDir, "storage-version")
	CurrBranchPath        = filepath.Join(SupabaseDirPath, ".branches", "_current_branch")
	MigrationsDir         = filepath.Join(SupabaseDirPath, "migrations")
	FunctionsDir          = filepath.Join(SupabaseDirPath, "functions")
	FallbackImportMapPath = filepath.Join(FunctionsDir, "import_map.json")
	FallbackEnvFilePath   = filepath.Join(FunctionsDir, ".env")
	DbTestsDir            = filepath.Join(SupabaseDirPath, "tests")
	SeedDataPath          = filepath.Join(SupabaseDirPath, "seed.sql")
	CustomRolesPath       = filepath.Join(SupabaseDirPath, "roles.sql")

	ErrNotLinked  = errors.New("Cannot find project ref. Have you run " + Aqua("supabase link") + "?")
	ErrInvalidRef = errors.New("Invalid project ref format. Must be like `abcdefghijklmnopqrst`.")
	ErrNotRunning = errors.Errorf("%s is not running.", Aqua("supabase start"))
)

func GetCurrentTimestamp() string {
	// Magic number: https://stackoverflow.com/q/45160822.
	return time.Now().UTC().Format("20060102150405")
}

func GetCurrentBranchFS(fsys afero.Fs) (string, error) {
	branch, err := afero.ReadFile(fsys, CurrBranchPath)
	if err != nil {
		return "", err
	}

	return string(branch), nil
}

func AssertSupabaseDbIsRunning() error {
	_, err := Docker.ContainerInspect(context.Background(), DbId)
	if client.IsErrNotFound(err) {
		return errors.New(ErrNotRunning)
	}
	if client.IsErrConnectionFailed(err) {
		CmdSuggestion = suggestDockerInstall
	}
	return err
}

func IsGitRepo() bool {
	opts := &git.PlainOpenOptions{DetectDotGit: true}
	_, err := git.PlainOpenWithOptions(".", opts)
	return err == nil
}

// If the `os.Getwd()` is within a supabase project, this will return
// the root of the given project as the current working directory.
// Otherwise, the `os.Getwd()` is kept as is.
func GetProjectRoot(fsys afero.Fs) (string, error) {
	origWd, err := os.Getwd()
	for cwd := origWd; err == nil; cwd = filepath.Dir(cwd) {
		path := filepath.Join(cwd, ConfigPath)
		// Treat all errors as file not exists
		if isSupaProj, _ := afero.Exists(fsys, path); isSupaProj {
			return cwd, nil
		}
		if isRootDirectory(cwd) {
			break
		}
	}
	return origWd, err
}

func IsBranchNameReserved(branch string) bool {
	switch branch {
	case "_current_branch", "main", "postgres", "template0", "template1":
		return true
	default:
		return false
	}
}

func MkdirIfNotExist(path string) error {
	return MkdirIfNotExistFS(afero.NewOsFs(), path)
}

func MkdirIfNotExistFS(fsys afero.Fs, path string) error {
	if err := fsys.MkdirAll(path, 0755); err != nil && !errors.Is(err, os.ErrExist) {
		return err
	}

	return nil
}

func WriteFile(path string, contents []byte, fsys afero.Fs) error {
	if err := MkdirIfNotExistFS(fsys, filepath.Dir(path)); err != nil {
		return err
	}
	return afero.WriteFile(fsys, path, contents, 0644)
}

func AssertSupabaseCliIsSetUpFS(fsys afero.Fs) error {
	if _, err := fsys.Stat(ConfigPath); errors.Is(err, os.ErrNotExist) {
		return errors.New("Cannot find " + Bold(ConfigPath) + " in the current directory. Have you set up the project with " + Aqua("supabase init") + "?")
	} else if err != nil {
		return err
	}

	return nil
}

func AssertProjectRefIsValid(projectRef string) error {
	if !ProjectRefPattern.MatchString(projectRef) {
		return ErrInvalidRef
	}
	return nil
}

func LoadProjectRef(fsys afero.Fs) (string, error) {
	projectRefBytes, err := afero.ReadFile(fsys, ProjectRefPath)
	if errors.Is(err, os.ErrNotExist) {
		return "", ErrNotLinked
	} else if err != nil {
		return "", err
	}
	projectRef := string(bytes.TrimSpace(projectRefBytes))
	if !ProjectRefPattern.MatchString(projectRef) {
		return "", ErrInvalidRef
	}
	return projectRef, nil
}

func ValidateFunctionSlug(slug string) error {
	if !FuncSlugPattern.MatchString(slug) {
		return errors.New("Invalid Function name. Must start with at least one letter, and only include alphanumeric characters, underscores, and hyphens. (^[A-Za-z][A-Za-z0-9_-]*$)")
	}

	return nil
}

func Ptr[T any](v T) *T {
	return &v
}
