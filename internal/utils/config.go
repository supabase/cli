package utils

import (
	_ "embed"
	"errors"
	"fmt"
	"os"
	"strconv"

	"github.com/BurntSushi/toml"
	"github.com/spf13/viper"
)

var (
	DbImage    string
	NetId      string
	DbId       string
	KongId     string
	GotrueId   string
	InbucketId string
	RealtimeId string
	RestId     string
	StorageId  string
	DifferId   string
	PgmetaId   string
	StudioId   string

	InitialSchemaSql string
	//go:embed templates/initial_schemas/13.sql
	initialSchemaPg13Sql string
	//go:embed templates/initial_schemas/14.sql
	initialSchemaPg14Sql string

	authExternalProviders = []string{
		"apple",
		"azure",
		"bitbucket",
		"discord",
		"facebook",
		"github",
		"gitlab",
		"google",
		"twitch",
		"twitter",
		"slack",
		"spotify",
	}
)

var Config supabaseConfig

type (
	supabaseConfig struct {
		ProjectId string `toml:"project_id"`
		Api       api
		Db        db
		Studio    studio
		Inbucket  inbucket
		Auth      auth
		// TODO
		// Scripts   scripts
	}

	api struct {
		Port            uint
		Schemas         []string
		ExtraSearchPath []string `toml:"extra_search_path"`
		MaxRows         uint     `toml:"max_rows"`
	}

	db struct {
		Port         uint
		MajorVersion uint `toml:"major_version"`
	}

	studio struct {
		Port uint
	}

	inbucket struct {
		Port uint
	}

	auth struct {
		SiteUrl                string   `toml:"site_url"`
		AdditionalRedirectUrls []string `toml:"additional_redirect_urls"`
		JwtExpiry              uint     `toml:"jwt_expiry"`
		EnableSignup           *bool    `toml:"enable_signup"`
		Email                  email
		External               map[string]provider
	}

	email struct {
		EnableSignup         *bool `toml:"enable_signup"`
		DoubleConfirmChanges *bool `toml:"double_confirm_changes"`
		EnableConfirmations  *bool `toml:"enable_confirmations"`
	}

	provider struct {
		Enabled  bool
		ClientId string `toml:"client_id"`
		Secret   string
	}

	// TODO
	// scripts struct {
	// 	BeforeMigrations string `toml:"before_migrations"`
	// 	AfterMigrations  string `toml:"after_migrations"`
	// }
)

func LoadConfig() error {
	if _, err := toml.DecodeFile("supabase/config.toml", &Config); err == nil {
		// skip
	} else if errors.Is(err, os.ErrNotExist) {
		_, _err := os.Stat("supabase/config.json")
		if errors.Is(_err, os.ErrNotExist) {
			return fmt.Errorf("Missing config: %w", err)
		} else if _err != nil {
			return fmt.Errorf("Failed to read config: %w", _err)
		}

		if err := handleDeprecatedConfig(); err != nil {
			return err
		}
	} else {
		return fmt.Errorf("Failed to read config: %w", err)
	}

	// Process decoded TOML.
	{
		if Config.ProjectId == "" {
			return errors.New("Missing required field in config: project_id")
		} else {
			NetId = "supabase_network_" + Config.ProjectId
			DbId = "supabase_db_" + Config.ProjectId
			KongId = "supabase_kong_" + Config.ProjectId
			GotrueId = "supabase_auth_" + Config.ProjectId
			InbucketId = "supabase_inbucket_" + Config.ProjectId
			RealtimeId = "supabase_realtime_" + Config.ProjectId
			RestId = "supabase_rest_" + Config.ProjectId
			StorageId = "supabase_storage_" + Config.ProjectId
			DifferId = "supabase_differ_" + Config.ProjectId
			PgmetaId = "supabase_pg_meta_" + Config.ProjectId
			StudioId = "supabase_studio_" + Config.ProjectId
		}
		if Config.Api.Port == 0 {
			return errors.New("Missing required field in config: api.port")
		}
		if Config.Api.MaxRows == 0 {
			Config.Api.MaxRows = 1000
		}
		if Config.Db.Port == 0 {
			return errors.New("Missing required field in config: db.port")
		}
		switch Config.Db.MajorVersion {
		case 0:
			return errors.New("Missing required field in config: db.major_version")
		case 12:
			return errors.New("Postgres version 12.x is unsupported. To use the CLI, either start a new project or follow project migration steps here: https://supabase.com/docs/guides/database#migrating-between-projects.")
		case 13:
			DbImage = "supabase/postgres:13.3.0"
			InitialSchemaSql = initialSchemaPg13Sql
		case 14:
			DbImage = "supabase/postgres:14.1.0"
			InitialSchemaSql = initialSchemaPg14Sql
		default:
			return fmt.Errorf("Failed reading config: Invalid %s: %v.", Aqua("db.major_version"), Config.Db.MajorVersion)
		}
		if Config.Studio.Port == 0 {
			return errors.New("Missing required field in config: studio.port")
		}
		if Config.Inbucket.Port == 0 {
			return errors.New("Missing required field in config: inbucket.port")
		}
		if Config.Auth.SiteUrl == "" {
			return errors.New("Missing required field in config: auth.site_url")
		}
		if Config.Auth.JwtExpiry == 0 {
			Config.Auth.JwtExpiry = 3600
		}
		if Config.Auth.EnableSignup == nil {
			x := true
			Config.Auth.EnableSignup = &x
		}
		if Config.Auth.Email.EnableSignup == nil {
			x := true
			Config.Auth.Email.EnableSignup = &x
		}
		if Config.Auth.Email.DoubleConfirmChanges == nil {
			x := true
			Config.Auth.Email.DoubleConfirmChanges = &x
		}
		if Config.Auth.Email.EnableConfirmations == nil {
			x := true
			Config.Auth.Email.EnableConfirmations = &x
		}
		if Config.Auth.External == nil {
			Config.Auth.External = map[string]provider{}
		}
		for _, ext := range authExternalProviders {
			if _, ok := Config.Auth.External[ext]; !ok {
				Config.Auth.External[ext] = provider{
					Enabled:  false,
					ClientId: "",
					Secret:   "",
				}
			} else if Config.Auth.External[ext].Enabled {
				if Config.Auth.External[ext].ClientId == "" {
					return fmt.Errorf("Missing required field in config: auth.external.%s.client_id", ext)
				}
				if Config.Auth.External[ext].Secret == "" {
					return fmt.Errorf("Missing required field in config: auth.external.%s.secret", ext)
				}
			}
		}
	}

	return nil
}

// TODO: Remove this after 2022-08-15.
func handleDeprecatedConfig() error {
	fmt.Println("WARNING: Found deprecated supabase/config.json. Converting to supabase/config.toml. Refer to release notes for details.")

	viper.SetConfigFile("supabase/config.json")
	if err := viper.ReadInConfig(); err != nil {
		return fmt.Errorf("Failed to read config: %w", err)
	}

	var inbucketPort uint
	if viper.IsSet("ports.inbucket") {
		inbucketPort = viper.GetUint("ports.inbucket")
	} else {
		inbucketPort = 54324
	}
	dbVersion := viper.GetString("dbVersion")
	dbMajorVersion, err := strconv.ParseUint(dbVersion[:len(dbVersion)-4], 10, 64)
	if err != nil {
		return err
	}

	newConfig := fmt.Sprintf(
		`# This config was autogenerated from the old supabase/config.json. Refer to docs and release notes for more details.
project_id = "%s"

[api]
port = %d

[db]
port = %d
major_version = %d

[studio]
port = %d

[inbucket]
port = %d

[auth]
site_url = "http://localhost:3000"
`,
		viper.GetString("projectId"),
		viper.GetUint("ports.api"),
		viper.GetUint("ports.db"),
		dbMajorVersion,
		viper.GetUint("ports.studio"),
		inbucketPort,
	)

	Config.ProjectId = viper.GetString("projectId")
	Config.Api.Port = viper.GetUint("ports.api")
	Config.Db.Port = viper.GetUint("ports.db")
	Config.Studio.Port = viper.GetUint("ports.studio")
	Config.Inbucket.Port = inbucketPort
	Config.Db.MajorVersion = uint(dbMajorVersion)
	Config.Auth.SiteUrl = "http://localhost:3000"

	if err := os.WriteFile("supabase/config.toml", []byte(newConfig), 0644); err != nil {
		return err
	}
	if err := os.Remove("supabase/config.json"); err != nil {
		return err
	}

	return nil
}
