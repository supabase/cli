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

	"github.com/spf13/viper"
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

var (
	ApiPort      string
	InbucketPort string
	DbPort       string
	StudioPort   string
	DbVersion    string
	DbImage      string
	ProjectId    string
	NetId        string
	DbId         string
	KongId       string
	GotrueId     string
	InbucketId   string
	RealtimeId   string
	RestId       string
	StorageId    string
	DifferId     string
	PgmetaId     string
	StudioId     string

	//go:embed templates/globals.sql
	GlobalsSql       string
	InitialSchemaSql string
	//go:embed templates/initial_schemas/13.sql
	initialSchemaPg13Sql string
	//go:embed templates/initial_schemas/14.sql
	initialSchemaPg14Sql string
)

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

func LoadConfig() error {
	viper.SetConfigFile("supabase/config.json")
	if err := viper.ReadInConfig(); err != nil {
		return fmt.Errorf("Failed to read config: %w", err)
	}

	ApiPort = fmt.Sprint(viper.GetUint("ports.api"))
	if viper.IsSet("ports.inbucket") {
		InbucketPort = fmt.Sprint(viper.GetUint("ports.inbucket"))
	}
	DbPort = fmt.Sprint(viper.GetUint("ports.db"))
	StudioPort = fmt.Sprint(viper.GetUint("ports.studio"))
	DbVersion = viper.GetString("dbVersion")
	switch DbVersion {
	case
		"120000",
		"120001",
		"120002",
		"120003",
		"120004",
		"120005",
		"120006",
		"120007",
		"120008":
		return errors.New("Postgres version 12.x is unsupported. To use the CLI, either start a new project or follow project migration steps here: https://supabase.com/docs/guides/database#migrating-between-projects.")
	case
		"130000",
		"130001",
		"130002",
		"130003",
		"130004":
		DbImage = "supabase/postgres:13.3.0"
		InitialSchemaSql = initialSchemaPg13Sql
	case
		"140000",
		"140001":
		DbImage = "supabase/postgres:14.1.0"
		InitialSchemaSql = initialSchemaPg14Sql
	default:
		return errors.New("Failed reading config: Invalid " + Aqua("dbVersion") + ": " + DbVersion + ".")
	}
	ProjectId = viper.GetString("projectId")
	NetId = "supabase_network_" + ProjectId
	DbId = "supabase_db_" + ProjectId
	KongId = "supabase_kong_" + ProjectId
	GotrueId = "supabase_auth_" + ProjectId
	InbucketId = "supabase_inbucket_" + ProjectId
	RealtimeId = "supabase_realtime_" + ProjectId
	RestId = "supabase_rest_" + ProjectId
	StorageId = "supabase_storage_" + ProjectId
	DifferId = "supabase_differ_" + ProjectId
	PgmetaId = "supabase_pg_meta_" + ProjectId
	StudioId = "supabase_studio_" + ProjectId

	return nil
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
