package utils

import (
	"errors"
	"fmt"

	"github.com/spf13/viper"
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

	InitialSchemaSql string
	//go:embed templates/initial_schemas/13.sql
	initialSchemaPg13Sql string
	//go:embed templates/initial_schemas/14.sql
	initialSchemaPg14Sql string
)

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
