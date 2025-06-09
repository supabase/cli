package utils

import (
	"context"
	_ "embed"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"regexp"
	"time"

	"github.com/containerd/errdefs"
	"github.com/docker/docker/client"
	"github.com/go-errors/errors"
	"github.com/go-git/go-git/v5"
	"github.com/spf13/afero"
	"github.com/spf13/viper"
	"github.com/supabase/cli/pkg/migration"
)

// Assigned using `-ldflags` https://stackoverflow.com/q/11354518
var (
	Version   string
	SentryDsn string
)

func ShortContainerImageName(imageName string) string {
	matches := ImageNamePattern.FindStringSubmatch(imageName)
	if len(matches) < 2 {
		return imageName
	}
	return matches[1]
}

const SuggestDebugFlag = "Try rerunning the command with --debug to troubleshoot the error."

var (
	CmdSuggestion string
	CurrentDirAbs string

	// pg_dumpall --globals-only --no-role-passwords --dbname $DB_URL \
	// | sed '/^CREATE ROLE postgres;/d' \
	// | sed '/^ALTER ROLE postgres WITH /d' \
	// | sed "/^ALTER ROLE .* WITH .* LOGIN /s/;$/ PASSWORD 'postgres';/"
	//go:embed templates/globals.sql
	GlobalsSql string

	ProjectRefPattern  = regexp.MustCompile(`^[a-z]{20}$`)
	UUIDPattern        = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)
	ProjectHostPattern = regexp.MustCompile(`^(db\.)([a-z]{20})\.supabase\.(co|red)$`)
	BranchNamePattern  = regexp.MustCompile(`[[:word:]-]+`)
	FuncSlugPattern    = regexp.MustCompile(`^[A-Za-z][A-Za-z0-9_-]*$`)
	ImageNamePattern   = regexp.MustCompile(`\/(.*):`)

	// These schemas are ignored from db diff and db dump
	PgSchemas       = migration.InternalSchemas[:2]
	InternalSchemas = migration.InternalSchemas

	SupabaseDirPath       = "supabase"
	ConfigPath            = filepath.Join(SupabaseDirPath, "config.toml")
	GitIgnorePath         = filepath.Join(SupabaseDirPath, ".gitignore")
	TempDir               = filepath.Join(SupabaseDirPath, ".temp")
	ImportMapsDir         = filepath.Join(TempDir, "import_maps")
	ProjectRefPath        = filepath.Join(TempDir, "project-ref")
	PoolerUrlPath         = filepath.Join(TempDir, "pooler-url")
	PostgresVersionPath   = filepath.Join(TempDir, "postgres-version")
	GotrueVersionPath     = filepath.Join(TempDir, "gotrue-version")
	RestVersionPath       = filepath.Join(TempDir, "rest-version")
	StorageVersionPath    = filepath.Join(TempDir, "storage-version")
	StudioVersionPath     = filepath.Join(TempDir, "studio-version")
	PgmetaVersionPath     = filepath.Join(TempDir, "pgmeta-version")
	PoolerVersionPath     = filepath.Join(TempDir, "pooler-version")
	RealtimeVersionPath   = filepath.Join(TempDir, "realtime-version")
	CliVersionPath        = filepath.Join(TempDir, "cli-latest")
	CurrBranchPath        = filepath.Join(SupabaseDirPath, ".branches", "_current_branch")
	SchemasDir            = filepath.Join(SupabaseDirPath, "schemas")
	MigrationsDir         = filepath.Join(SupabaseDirPath, "migrations")
	FunctionsDir          = filepath.Join(SupabaseDirPath, "functions")
	FallbackImportMapPath = filepath.Join(FunctionsDir, "import_map.json")
	FallbackEnvFilePath   = filepath.Join(FunctionsDir, ".env")
	DbTestsDir            = filepath.Join(SupabaseDirPath, "tests")
	CustomRolesPath       = filepath.Join(SupabaseDirPath, "roles.sql")

	ErrNotLinked   = errors.Errorf("Cannot find project ref. Have you run %s?", Aqua("supabase link"))
	ErrInvalidRef  = errors.New("Invalid project ref format. Must be like `abcdefghijklmnopqrst`.")
	ErrInvalidSlug = errors.New("Invalid Function name. Must start with at least one letter, and only include alphanumeric characters, underscores, and hyphens. (^[A-Za-z][A-Za-z0-9_-]*$)")
	ErrNotRunning  = errors.Errorf("%s is not running.", Aqua("supabase start"))
)

func GetCurrentTimestamp() string {
	// Magic number: https://stackoverflow.com/q/45160822.
	return time.Now().UTC().Format(layoutVersion)
}

func GetCurrentBranchFS(fsys afero.Fs) (string, error) {
	branch, err := afero.ReadFile(fsys, CurrBranchPath)
	if err != nil {
		return "", errors.Errorf("failed to load current branch: %w", err)
	}

	return string(branch), nil
}

func AssertSupabaseDbIsRunning() error {
	return AssertServiceIsRunning(context.Background(), DbId)
}

func AssertServiceIsRunning(ctx context.Context, containerId string) error {
	if _, err := Docker.ContainerInspect(ctx, containerId); err != nil {
		if errdefs.IsNotFound(err) {
			return errors.New(ErrNotRunning)
		}
		if client.IsErrConnectionFailed(err) {
			CmdSuggestion = suggestDockerInstall
		}
		return errors.Errorf("failed to inspect service: %w", err)
	}
	return nil
}

func IsGitRepo() bool {
	opts := &git.PlainOpenOptions{DetectDotGit: true}
	_, err := git.PlainOpenWithOptions(".", opts)
	return err == nil
}

// If the `os.Getwd()` is within a supabase project, this will return
// the root of the given project as the current working directory.
// Otherwise, the `os.Getwd()` is kept as is.
func getProjectRoot(absPath string, fsys afero.Fs) string {
	for cwd := absPath; ; cwd = filepath.Dir(cwd) {
		path := filepath.Join(cwd, ConfigPath)
		// Treat all errors as file not exists
		if isSupaProj, err := afero.Exists(fsys, path); isSupaProj {
			return cwd
		} else if err != nil && !errors.Is(err, os.ErrNotExist) {
			logger := GetDebugLogger()
			fmt.Fprintln(logger, err)
		}
		if isRootDirectory(cwd) {
			break
		}
	}
	return absPath
}

func isRootDirectory(cleanPath string) bool {
	// A cleaned path only ends with separator if it is root
	return os.IsPathSeparator(cleanPath[len(cleanPath)-1])
}

func ChangeWorkDir(fsys afero.Fs) error {
	// Track the original workdir before changing to project root
	if !filepath.IsAbs(CurrentDirAbs) {
		var err error
		if CurrentDirAbs, err = os.Getwd(); err != nil {
			return errors.Errorf("failed to get current directory: %w", err)
		}
	}
	workdir := viper.GetString("WORKDIR")
	if len(workdir) == 0 {
		workdir = getProjectRoot(CurrentDirAbs, fsys)
	}
	if err := os.Chdir(workdir); err != nil {
		return errors.Errorf("failed to change workdir: %w", err)
	}
	if cwd, err := os.Getwd(); err == nil && cwd != CurrentDirAbs {
		fmt.Fprintln(os.Stderr, "Using workdir", Bold(workdir))
	}
	return nil
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
		return errors.Errorf("failed to mkdir: %w", err)
	}

	return nil
}

func WriteFile(path string, contents []byte, fsys afero.Fs) error {
	if err := MkdirIfNotExistFS(fsys, filepath.Dir(path)); err != nil {
		return err
	}
	if err := afero.WriteFile(fsys, path, contents, 0644); err != nil {
		return errors.Errorf("failed to write file: %w", err)
	}
	return nil
}

func AssertProjectRefIsValid(projectRef string) error {
	if !ProjectRefPattern.MatchString(projectRef) {
		return errors.New(ErrInvalidRef)
	}
	return nil
}

func ValidateFunctionSlug(slug string) error {
	if !FuncSlugPattern.MatchString(slug) {
		return errors.New(ErrInvalidSlug)
	}

	return nil
}

func GetHostname() string {
	host := Docker.DaemonHost()
	if parsed, err := client.ParseHostURL(host); err == nil && parsed.Scheme == "tcp" {
		if host, _, err := net.SplitHostPort(parsed.Host); err == nil {
			return host
		}
	}
	return "127.0.0.1"
}
