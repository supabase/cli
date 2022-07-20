package utils

import (
	"bytes"
	_ "embed"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"text/template"

	"github.com/BurntSushi/toml"
	"github.com/spf13/afero"
	"github.com/spf13/viper"
)

var (
	DbImage     string
	NetId       string
	DbId        string
	KongId      string
	GotrueId    string
	InbucketId  string
	RealtimeId  string
	RestId      string
	StorageId   string
	DifferId    string
	PgmetaId    string
	StudioId    string
	DenoRelayId string

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

	//go:embed templates/init_config.toml
	initConfigEmbed       string
	initConfigTemplate, _ = template.New("initConfig").Parse(initConfigEmbed)

	//go:embed templates/init_config.test.toml
	testInitConfigEmbed       string
	testInitConfigTemplate, _ = template.New("initConfig.test").Parse(testInitConfigEmbed)
)

var Config config

type (
	config struct {
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
		Port     uint
		SmtpPort uint `toml:"smtp_port"`
		Pop3Port uint `toml:"pop3_port"`
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
	return loadConfig(afero.NewOsFs())
}

func loadConfig(fsys afero.Fs) error {
	// TODO: provide a config interface for all sub commands to use fsys
	if _, err := toml.DecodeFS(afero.NewIOFS(fsys), "supabase/config.toml", &Config); err == nil {
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
			DenoRelayId = "supabase_deno_relay_" + Config.ProjectId
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
			DbImage = "supabase/postgres:14.1.0.21"
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
			}
		}
	}

	return nil
}

func InterpolateEnvInConfig() error {
	maybeLoadEnv := func(s string) (string, error) {
		matches := regexp.MustCompile(`^env\((.*)\)$`).FindStringSubmatch(s)
		if len(matches) == 0 {
			return s, nil
		}

		envName := matches[1]
		value := os.Getenv(envName)
		if value == "" {
			return "", errors.New(`Error evaluating "env(` + envName + `)": environment variable ` + envName + " is unset.")
		}

		return value, nil
	}

	for _, ext := range authExternalProviders {
		if Config.Auth.External[ext].Enabled {
			var clientId, secret string

			if Config.Auth.External[ext].ClientId == "" {
				return fmt.Errorf("Missing required field in config: auth.external.%s.client_id", ext)
			} else {
				v, err := maybeLoadEnv(Config.Auth.External[ext].ClientId)
				if err != nil {
					return err
				}
				clientId = v
			}
			if Config.Auth.External[ext].Secret == "" {
				return fmt.Errorf("Missing required field in config: auth.external.%s.secret", ext)
			} else {
				v, err := maybeLoadEnv(Config.Auth.External[ext].Secret)
				if err != nil {
					return err
				}
				secret = v
			}

			Config.Auth.External[ext] = provider{
				Enabled:  true,
				ClientId: clientId,
				Secret:   secret,
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
		`# A string used to distinguish different Supabase projects on the same host. Defaults to the working
# directory name when running supabase init.
project_id = "%s"

[api]
# Port to use for the API URL.
port = %d
# Schemas to expose in your API. Tables, views and stored procedures in this schema will get API
# endpoints. public and storage are always included.
schemas = []
# Extra schemas to add to the search_path of every request.
extra_search_path = ["extensions"]
# The maximum number of rows returns from a view, table, or stored procedure. Limits payload size
# for accidental or malicious requests.
max_rows = 1000

[db]
# Port to use for the local database URL.
port = %d
# The database major version to use. This has to be the same as your remote database's. Run SHOW
# server_version; on the remote database to check.
major_version = %d

[studio]
# Port to use for Supabase Studio.
port = %d

# Email testing server. Emails sent with the local dev setup are not actually sent - rather, they
# are monitored, and you can view the emails that would have been sent from the web interface.
[inbucket]
# Port to use for the email testing server web interface.
port = %d

[auth]
# The base URL of your website. Used as an allow-list for redirects and for constructing URLs used
# in emails.
site_url = "http://localhost:3000"
# A list of *exact* URLs that auth providers are permitted to redirect to post authentication.
additional_redirect_urls = ["https://localhost:3000"]
# How long tokens are valid for, in seconds. Defaults to 3600 (1 hour), maximum 604,800 seconds (one
# week).
jwt_expiry = 3600
# Allow/disallow new user signups to your project.
enable_signup = true

[auth.email]
# Allow/disallow new user signups via email to your project.
enable_signup = true
# If enabled, a user will be required to confirm any email change on both the old, and new email
# addresses. If disabled, only the new email is required to confirm.
double_confirm_changes = true
# If enabled, users need to confirm their email address before signing in.
enable_confirmations = false

# Use an external OAuth provider. The full list of providers are: apple, azure, bitbucket,
# discord, facebook, github, gitlab, google, twitch, twitter, slack, spotify.
[auth.external.apple]
enabled = false
client_id = ""
secret = ""
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

func WriteConfig(fsys afero.Fs, test bool) error {
	// Using current directory name as project id
	cwd, err := os.Getwd()
	if err != nil {
		return err
	}
	dir := filepath.Base(cwd)

	var initConfigBuf bytes.Buffer
	var tmpl *template.Template
	if test {
		tmpl = testInitConfigTemplate
	} else {
		tmpl = initConfigTemplate
	}

	if err := tmpl.Execute(
		&initConfigBuf,
		struct{ ProjectId string }{ProjectId: dir},
	); err != nil {
		return err
	}

	if err := afero.WriteFile(fsys, "supabase/config.toml", initConfigBuf.Bytes(), 0644); err != nil {
		return err
	}

	return nil
}
