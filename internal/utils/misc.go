package utils

import (
	"archive/zip"
	"bytes"
	"context"
	"crypto/md5"
	"embed"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"time"

	"github.com/spf13/afero"
)

const (
	Pg13Image = "supabase/postgres:13.3.0"
	Pg14Image = "supabase/postgres:14.1.0.89"
	// Append to ServiceImages when adding new dependencies below
	KongImage       = "library/kong:2.8.1"
	InbucketImage   = "inbucket/inbucket:3.0.3"
	PostgrestImage  = "postgrest/postgrest:v10.1.1.20221212"
	DifferImage     = "supabase/pgadmin-schema-diff:cli-0.0.5"
	MigraImage      = "djrobstep/migra:3.0.1621480950"
	PgmetaImage     = "supabase/postgres-meta:v0.53.1"
	StudioImage     = "supabase/studio:20221214-4eecc99"
	DenoRelayImage  = "supabase/deno-relay:v1.5.0"
	ImageProxyImage = "supabase/imgproxy:v1.0.4"
	// Update initial schemas in internal/utils/templates/initial_schemas when
	// updating any one of these.
	GotrueImage   = "supabase/gotrue:v2.25.1"
	RealtimeImage = "supabase/realtime:v1.0.0-rc.11"
	StorageImage  = "supabase/storage-api:v0.26.1"
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
	DenoRelayImage,
}

func ShortContainerImageName(imageName string) string {
	matches := ImageNamePattern.FindStringSubmatch(imageName)
	if len(matches) < 2 {
		return imageName
	}
	return matches[1]
}

const (
	ShadowDbName = "supabase_shadow"

	// https://dba.stackexchange.com/a/11895
	// Args: dbname
	TerminateDbSqlFmt = `
SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '%[1]s';
-- Wait for WAL sender to drop replication slot.
DO 'BEGIN WHILE (
	SELECT COUNT(*) FROM pg_replication_slots WHERE database = ''%[1]s''
) > 0 LOOP END LOOP; END';`
	AnonKey        = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0"
	ServiceRoleKey = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU"
	JWTSecret      = "super-secret-jwt-token-with-at-least-32-characters-long"

	ConfigPath     = "supabase/config.toml"
	ProjectRefPath = "supabase/.temp/project-ref"
	RemoteDbPath   = "supabase/.temp/remote-db-url"
	CurrBranchPath = "supabase/.branches/_current_branch"
	MigrationsDir  = "supabase/migrations"
	FunctionsDir   = "supabase/functions"
	DbTestsDir     = "supabase/tests"
	SeedDataPath   = "supabase/seed.sql"
)

var (
	// pg_dumpall --globals-only --no-role-passwords --dbname $DB_URL \
	// | sed '/^CREATE ROLE postgres;/d' \
	// | sed '/^ALTER ROLE postgres WITH /d' \
	// | sed "/^ALTER ROLE .* WITH .* LOGIN /s/;$/ PASSWORD 'postgres';/"
	//go:embed templates/globals.sql
	GlobalsSql string

	//go:embed eszip/*
	eszipEmbedDir embed.FS

	AccessTokenPattern = regexp.MustCompile(`^sbp_[a-f0-9]{40}$`)
	ProjectRefPattern  = regexp.MustCompile(`^[a-z]{20}$`)
	PostgresUrlPattern = regexp.MustCompile(`^postgres(?:ql)?:\/\/postgres:(.*)@(.+)\/postgres$`)
	MigrateFilePattern = regexp.MustCompile(`^([0-9]+)_.*\.sql$`)
	BranchNamePattern  = regexp.MustCompile(`[[:word:]-]+`)
	FuncSlugPattern    = regexp.MustCompile(`^[A-Za-z][A-Za-z0-9_-]*$`)
	ImageNamePattern   = regexp.MustCompile(`\/(.*):`)

	// These schemas are ignored from schema diffs
	InternalSchemas = []string{
		"auth",
		"extensions",
		"graphql",
		"graphql_public",
		"pgbouncer",
		"pgsodium",
		"pgsodium_masks",
		"_realtime",
		"realtime",
		"storage",
		"supabase_functions",
		"supabase_migrations",
		"pg_catalog",
		"pg_toast",
		"information_schema",
	}
)

// Used by unit tests
var (
	DenoPathOverride string
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

// TODO: Make all errors use this.
func NewError(s string) error {
	// Ask runtime.Callers for up to 5 PCs, excluding runtime.Callers and NewError.
	pc := make([]uintptr, 5)
	n := runtime.Callers(2, pc)

	pc = pc[:n] // pass only valid pcs to runtime.CallersFrames
	frames := runtime.CallersFrames(pc)

	// Loop to get frames.
	// A fixed number of PCs can expand to an indefinite number of Frames.
	for {
		frame, more := frames.Next()

		// Process this frame.
		//
		// We're only interested in the stack trace in this repo.
		if strings.HasPrefix(frame.Function, "github.com/supabase/cli/internal") {
			s += fmt.Sprintf("\n  in %s:%d", frame.Function, frame.Line)
		}

		// Check whether there are more frames to process after this one.
		if !more {
			break
		}
	}

	return errors.New(s)
}

func AssertSupabaseDbIsRunning() error {
	if _, err := Docker.ContainerInspect(context.Background(), DbId); err != nil {
		return errors.New(Aqua("supabase start") + " is not running.")
	}

	return nil
}

func GetGitRoot(fsys afero.Fs) (*string, error) {
	origWd, err := os.Getwd()
	if err != nil {
		return nil, err
	}

	for {
		_, err := afero.ReadDir(fsys, ".git")

		if err == nil {
			gitRoot, err := os.Getwd()
			if err != nil {
				return nil, err
			}

			if err := os.Chdir(origWd); err != nil {
				return nil, err
			}

			return &gitRoot, nil
		}

		if cwd, err := os.Getwd(); err != nil {
			return nil, err
		} else if isRootDirectory(cwd) {
			return nil, nil
		}

		if err := os.Chdir(".."); err != nil {
			return nil, err
		}
	}
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
	case "_current_branch", "main", "supabase_shadow", "postgres", "template0", "template1":
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

func AssertSupabaseCliIsSetUpFS(fsys afero.Fs) error {
	if _, err := fsys.Stat(ConfigPath); errors.Is(err, os.ErrNotExist) {
		return errors.New("Cannot find " + Bold(ConfigPath) + " in the current directory. Have you set up the project with " + Aqua("supabase init") + "?")
	} else if err != nil {
		return err
	}

	return nil
}

func AssertIsLinkedFS(fsys afero.Fs) error {
	if _, err := fsys.Stat(ProjectRefPath); errors.Is(err, os.ErrNotExist) {
		return errors.New("Cannot find project ref. Have you run " + Aqua("supabase link") + "?")
	} else if err != nil {
		return err
	}

	return nil
}

func LoadProjectRef(fsys afero.Fs) (string, error) {
	projectRefBytes, err := afero.ReadFile(fsys, ProjectRefPath)
	if err != nil {
		return "", errors.New("Cannot find project ref. Have you run " + Aqua("supabase link") + "?")
	}
	projectRef := string(bytes.TrimSpace(projectRefBytes))
	if !ProjectRefPattern.MatchString(projectRef) {
		return "", errors.New("Invalid project ref format. Must be like `abcdefghijklmnopqrst`.")
	}
	return projectRef, nil
}

func GetDenoPath() (string, error) {
	if len(DenoPathOverride) > 0 {
		return DenoPathOverride, nil
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	denoBinName := "deno"
	if runtime.GOOS == "windows" {
		denoBinName = "deno.exe"
	}
	denoPath := filepath.Join(home, ".supabase", denoBinName)
	return denoPath, nil
}

func InstallOrUpgradeDeno(ctx context.Context, fsys afero.Fs) error {
	denoPath, err := GetDenoPath()
	if err != nil {
		return err
	}

	if _, err := fsys.Stat(denoPath); err == nil {
		// Upgrade Deno.
		cmd := exec.CommandContext(ctx, denoPath, "upgrade", "--version", "1.28.0")
		return cmd.Run()
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}

	// Install Deno.
	if err := MkdirIfNotExistFS(fsys, filepath.Dir(denoPath)); err != nil {
		return err
	}

	// 1. Determine OS triple
	var assetFilename string
	assetsUrl := "https://github.com/denoland/deno/releases/latest/download/"
	{
		if runtime.GOOS == "darwin" && runtime.GOARCH == "amd64" {
			assetFilename = "deno-x86_64-apple-darwin.zip"
		} else if runtime.GOOS == "darwin" && runtime.GOARCH == "arm64" {
			assetFilename = "deno-aarch64-apple-darwin.zip"
		} else if runtime.GOOS == "linux" && runtime.GOARCH == "amd64" {
			assetFilename = "deno-x86_64-unknown-linux-gnu.zip"
		} else if runtime.GOOS == "linux" && runtime.GOARCH == "arm64" {
			// TODO: version pin to official release once available https://github.com/denoland/deno/issues/1846
			assetsUrl = "https://github.com/LukeChannings/deno-arm64/releases/latest/download/"
			assetFilename = "deno-linux-arm64.zip"
		} else if runtime.GOOS == "windows" && runtime.GOARCH == "amd64" {
			assetFilename = "deno-x86_64-pc-windows-msvc.zip"
		} else {
			return errors.New("Platform " + runtime.GOOS + "/" + runtime.GOARCH + " is currently unsupported for Functions.")
		}
	}

	// 2. Download & install Deno binary.
	{
		req, err := http.NewRequestWithContext(ctx, "GET", assetsUrl+assetFilename, nil)
		if err != nil {
			return err
		}
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			return err
		}
		defer resp.Body.Close()

		if resp.StatusCode != 200 {
			return errors.New("Failed installing Deno binary.")
		}

		body, err := io.ReadAll(resp.Body)
		if err != nil {
			return err
		}

		r, err := zip.NewReader(bytes.NewReader(body), int64(len(body)))
		// There should be only 1 file: the deno binary
		if len(r.File) != 1 {
			return err
		}
		denoContents, err := r.File[0].Open()
		if err != nil {
			return err
		}
		defer denoContents.Close()

		denoBytes, err := io.ReadAll(denoContents)
		if err != nil {
			return err
		}

		if err := afero.WriteFile(fsys, denoPath, denoBytes, 0755); err != nil {
			return err
		}
	}

	return nil
}

func isBuildScriptModified(fsys afero.Fs, buildScriptPath string) (bool, error) {
	bs, err := afero.ReadFile(fsys, buildScriptPath)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return true, nil
		}
		return false, err
	}

	es, err := fs.ReadFile(eszipEmbedDir, "eszip/build.ts")
	if err != nil {
		return false, err
	}

	// compare the md5 checksum of current build script with user's copy.
	// if the checksums doesn't match, build script is modified.
	return md5.Sum(bs) != md5.Sum(es), nil
}

// Copy ESZIP scripts needed for function deploy, returning the build script path or an error.
func CopyEszipScripts(ctx context.Context, fsys afero.Fs) (string, error) {
	denoPath, err := GetDenoPath()
	if err != nil {
		return "", err
	}

	denoDirPath := filepath.Dir(denoPath)
	scriptDirPath := filepath.Join(denoDirPath, "eszip")
	buildScriptPath := filepath.Join(scriptDirPath, "build.ts")

	// make the script directory if not exist
	if err := MkdirIfNotExistFS(fsys, scriptDirPath); err != nil {
		return "", err
	}

	// check if the build script should be copied
	modified, err := isBuildScriptModified(fsys, buildScriptPath)
	if err != nil {
		return "", err
	}
	if !modified {
		return buildScriptPath, nil
	}

	// copy embed files to script directory
	err = fs.WalkDir(eszipEmbedDir, "eszip", func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}

		// skip copying the directory
		if d.IsDir() {
			return nil
		}

		contents, err := fs.ReadFile(eszipEmbedDir, path)
		if err != nil {
			return err
		}

		if err := afero.WriteFile(fsys, filepath.Join(denoDirPath, path), contents, 0666); err != nil {
			return err
		}

		return nil
	})

	if err != nil {
		return "", err
	}

	return filepath.Join(buildScriptPath), nil
}

func LoadAccessToken() (string, error) {
	return LoadAccessTokenFS(afero.NewOsFs())
}

func LoadAccessTokenFS(fsys afero.Fs) (string, error) {
	// Env takes precedence
	if accessToken := os.Getenv("SUPABASE_ACCESS_TOKEN"); accessToken != "" {
		if !AccessTokenPattern.MatchString(accessToken) {
			return "", errors.New("Invalid access token format. Must be like `sbp_0102...1920`.")
		}

		return accessToken, nil
	}

	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	accessTokenPath := filepath.Join(home, ".supabase", "access-token")
	accessToken, err := afero.ReadFile(fsys, accessTokenPath)
	if errors.Is(err, os.ErrNotExist) || string(accessToken) == "" {
		return "", errors.New("Access token not provided. Supply an access token by running " + Aqua("supabase login") + " or setting the SUPABASE_ACCESS_TOKEN environment variable.")
	} else if err != nil {
		return "", err
	}

	return string(accessToken), nil
}

func ValidateFunctionSlug(slug string) error {
	if !FuncSlugPattern.MatchString(slug) {
		return errors.New("Invalid Function name. Must start with at least one letter, and only include alphanumeric characters, underscores, and hyphens. (^[A-Za-z][A-Za-z0-9_-]*$)")
	}

	return nil
}

func ShowStatus() {
	fmt.Println(`
         ` + Aqua("API URL") + `: http://localhost:` + strconv.FormatUint(uint64(Config.Api.Port), 10) + `
          ` + Aqua("DB URL") + `: postgresql://postgres:postgres@localhost:` + strconv.FormatUint(uint64(Config.Db.Port), 10) + `/postgres
      ` + Aqua("Studio URL") + `: http://localhost:` + strconv.FormatUint(uint64(Config.Studio.Port), 10) + `
    ` + Aqua("Inbucket URL") + `: http://localhost:` + strconv.FormatUint(uint64(Config.Inbucket.Port), 10) + `
      ` + Aqua("JWT secret") + `: ` + JWTSecret + `
        ` + Aqua("anon key") + `: ` + AnonKey + `
` + Aqua("service_role key") + `: ` + ServiceRoleKey)
}
