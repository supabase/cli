package utils

import (
	"context"
	_ "embed"
	"errors"
	"fmt"
	"os"
	"runtime"
	"strings"
	"time"
)

// Update initial schemas in internal/utils/templates/initial_schemas when
// updating any one of these.
const (
	GotrueImage   = "supabase/gotrue:v2.5.5"
	RealtimeImage = "supabase/realtime:v0.21.0"
	StorageImage  = "supabase/storage-api:v0.11.0"
)

const (
	ShadowDbName   = "supabase_shadow"
	KongImage      = "library/kong:2.1"
	InbucketImage  = "inbucket/inbucket:stable"
	PostgrestImage = "postgrest/postgrest:v9.0.0.20220107"
	DifferImage    = "supabase/pgadmin-schema-diff:cli-0.0.4"
	PgmetaImage    = "supabase/postgres-meta:v0.33.2"
	// TODO: Hardcode version once provided upstream.
	StudioImage = "supabase/studio:latest"

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
