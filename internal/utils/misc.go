package utils

import (
	"archive/zip"
	"bytes"
	"context"
	_ "embed"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"regexp"
	"runtime"
	"strings"
	"time"

	"github.com/adrg/xdg"
)

// Update initial schemas in internal/utils/templates/initial_schemas when
// updating any one of these.
const (
	GotrueImage   = "supabase/gotrue:v2.5.8"
	RealtimeImage = "supabase/realtime:v0.22.0"
	StorageImage  = "supabase/storage-api:v0.12.0"
)

const (
	ShadowDbName   = "supabase_shadow"
	KongImage      = "library/kong:2.1"
	InbucketImage  = "inbucket/inbucket:stable"
	PostgrestImage = "postgrest/postgrest:v9.0.0.20220211"
	DifferImage    = "supabase/pgadmin-schema-diff:cli-0.0.4"
	PgmetaImage    = "supabase/postgres-meta:v0.33.2"
	// TODO: Hardcode version once provided upstream.
	StudioImage    = "supabase/studio:latest"
	DenoRelayImage = "supabase/deno-relay:v1.0.5"

	// https://dba.stackexchange.com/a/11895
	// Args: dbname
	TerminateDbSqlFmt = `
SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '%[1]s';
-- Wait for WAL sender to drop replication slot.
DO 'BEGIN WHILE (SELECT COUNT(*) FROM pg_replication_slots) > 0 LOOP END LOOP; END';
`
)

//go:embed templates/globals.sql
var GlobalsSql string

func GetCurrentTimestamp() string {
	// Magic number: https://stackoverflow.com/q/45160822.
	return time.Now().UTC().Format("20060102150405")
}

func GetCurrentBranch() (string, error) {
	branch, err := os.ReadFile("supabase/.branches/_current_branch")
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

func AssertSupabaseStartIsRunning() error {
	if err := LoadConfig(); err != nil {
		return err
	}

	if _, err := Docker.ContainerInspect(context.Background(), DbId); err != nil {
		return errors.New(Aqua("supabase start") + " is not running.")
	}

	return nil
}

func GetGitRoot() (*string, error) {
	origWd, err := os.Getwd()
	if err != nil {
		return nil, err
	}

	for {
		_, err := os.ReadDir(".git")

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

func IsBranchNameReserved(branch string) bool {
	switch branch {
	case "_current_branch", "main", "supabase_shadow", "postgres", "template0", "template1":
		return true
	default:
		return false
	}
}

func MkdirIfNotExist(path string) error {
	if err := os.Mkdir(path, 0755); err != nil && !errors.Is(err, os.ErrExist) {
		return err
	}

	return nil
}

func AssertSupabaseCliIsSetUp() error {
	if _, err := os.ReadDir("supabase"); errors.Is(err, os.ErrNotExist) {
		return errors.New("Cannot find " + Bold("supabase") + " in the current directory. Have you set up the project with " + Aqua("supabase init") + "?")
	} else if err != nil {
		return err
	}

	return nil
}

func AssertIsLinked() error {
	if _, err := os.Stat("supabase/.temp/project-ref"); errors.Is(err, os.ErrNotExist) {
		return errors.New("Cannot find project ref. Have you run " + Aqua("supabase link") + "?")
	} else if err != nil {
		return err
	}

	return nil
}

func InstallOrUpgradeDeno() error {
	denoPath, err := xdg.ConfigFile("supabase/deno")
	if err != nil {
		return err
	}

	if _, err := os.Stat(denoPath); err == nil {
		// Upgrade Deno.

		cmd := exec.Command(denoPath, "upgrade")
		if err := cmd.Run(); err != nil {
			return err
		}

		return nil
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}

	// Install Deno.

	// 1. Determine OS triple
	var assetFilename string
	{
		if runtime.GOOS == "darwin" && runtime.GOARCH == "amd64" {
			assetFilename = "deno-x86_64-apple-darwin.zip"
		} else if runtime.GOOS == "darwin" && runtime.GOARCH == "arm64" {
			assetFilename = "deno-aarch64-apple-darwin.zip"
		} else if runtime.GOOS == "linux" && runtime.GOARCH == "amd64" {
			assetFilename = "deno-x86_64-unknown-linux-gnu.zip"
		} else if runtime.GOOS == "windows" && runtime.GOARCH == "amd64" {
			assetFilename = "deno-x86_64-pc-windows-msvc.zip"
		} else {
			return errors.New("Platform " + runtime.GOOS + "/" + runtime.GOARCH + " is currently unsupported for Functions.")
		}
	}

	// 2. Download & install Deno binary.
	{
		resp, err := http.Get("https://github.com/denoland/deno/releases/latest/download/" + assetFilename)
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

		if err := os.WriteFile(denoPath, denoBytes, 0755); err != nil {
			return err
		}
	}

	return nil
}

func LoadAccessToken() (string, error) {
	// Env takes precedence
	if accessToken := os.Getenv("SUPABASE_ACCESS_TOKEN"); accessToken != "" {
		matched, err := regexp.MatchString(`^sbp_[a-f0-9]{40}$`, accessToken)
		if err != nil {
			return "", err
		}
		if !matched {
			return "", errors.New("Invalid access token format. Must be like `sbp_0102...1920`.")
		}

		return accessToken, nil
	}

	accessTokenPath, err := xdg.ConfigFile("supabase/access-token")
	if err != nil {
		return "", err
	}
	accessToken, err := os.ReadFile(accessTokenPath)
	if errors.Is(err, os.ErrNotExist) || string(accessToken) == "" {
		return "", errors.New("Access token not provided. Supply an access token by running " + Aqua("supabase login") + " or setting the SUPABASE_ACCESS_TOKEN environment variable.")
	} else if err != nil {
		return "", err
	}

	return string(accessToken), nil
}

func ValidateFunctionSlug(slug string) error {
	matched, err := regexp.MatchString(`^[A-Za-z][A-Za-z0-9_-]*$`, slug)
	if err != nil {
		return err
	}
	if !matched {
		return errors.New("Invalid Function name. Must start with at least one letter, and only include alphanumeric characters, underscores, and hyphens. (^[A-Za-z][A-Za-z0-9_-]*$)")
	}

	return nil
}
