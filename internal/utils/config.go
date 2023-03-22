package utils

import (
	_ "embed"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"text/template"

	"github.com/BurntSushi/toml"
	"github.com/docker/go-units"
	"github.com/joho/godotenv"
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
	ImgProxyId  string
	DifferId    string
	PgmetaId    string
	StudioId    string
	DenoRelayId string
	LogflareId  string
	VectorId    string

	InitialSchemaSql string
	//go:embed templates/initial_schemas/13.sql
	InitialSchemaPg13Sql string
	//go:embed templates/initial_schemas/14.sql
	InitialSchemaPg14Sql string
	//go:embed templates/initial_schemas/15.sql
	InitialSchemaPg15Sql string

	authExternalProviders = []string{
		"apple",
		"azure",
		"bitbucket",
		"discord",
		"facebook",
		"github",
		"gitlab",
		"google",
		"keycloak",
		"linkedin",
		"notion",
		"twitch",
		"twitter",
		"slack",
		"spotify",
		"workos",
		"zoom",
	}

	//go:embed templates/init_config.toml
	initConfigEmbed    string
	initConfigTemplate = template.Must(template.New("initConfig").Parse(initConfigEmbed))
)

// Type for turning human-friendly bytes string ("5MB", "32kB") into an int64 during toml decoding.
type sizeInBytes int64

func (s *sizeInBytes) UnmarshalText(text []byte) error {
	size, err := units.RAMInBytes(string(text))
	if err == nil {
		*s = sizeInBytes(size)
	}
	return err
}

var Config config

type (
	config struct {
		ProjectId string              `toml:"project_id"`
		Api       api                 `toml:"api"`
		Db        db                  `toml:"db"`
		Studio    studio              `toml:"studio"`
		Inbucket  inbucket            `toml:"inbucket"`
		Storage   storage             `toml:"storage"`
		Auth      auth                `toml:"auth" mapstructure:"auth"`
		Functions map[string]function `toml:"functions"`
		Analytics analytics           `toml:"analytics"`
		// TODO
		// Scripts   scripts
	}

	api struct {
		Port            uint     `toml:"port"`
		Schemas         []string `toml:"schemas"`
		ExtraSearchPath []string `toml:"extra_search_path"`
		MaxRows         uint     `toml:"max_rows"`
	}

	db struct {
		Port         uint `toml:"port"`
		ShadowPort   uint `toml:"shadow_port"`
		MajorVersion uint `toml:"major_version"`
	}

	studio struct {
		Port uint `toml:"port"`
	}

	inbucket struct {
		Port     uint `toml:"port"`
		SmtpPort uint `toml:"smtp_port"`
		Pop3Port uint `toml:"pop3_port"`
	}

	storage struct {
		FileSizeLimit sizeInBytes `toml:"file_size_limit"`
	}

	auth struct {
		SiteUrl                string   `toml:"site_url"`
		AdditionalRedirectUrls []string `toml:"additional_redirect_urls"`
		JwtExpiry              uint     `toml:"jwt_expiry"`
		EnableSignup           *bool    `toml:"enable_signup"`
		Email                  email    `toml:"email"`
		External               map[string]provider
		// Custom secrets can be injected from .env file
		JwtSecret      string `toml:"-" mapstructure:"jwt_secret"`
		AnonKey        string `toml:"-" mapstructure:"anon_key"`
		ServiceRoleKey string `toml:"-" mapstructure:"service_role_key"`
	}

	email struct {
		EnableSignup         *bool `toml:"enable_signup"`
		DoubleConfirmChanges *bool `toml:"double_confirm_changes"`
		EnableConfirmations  *bool `toml:"enable_confirmations"`
	}

	provider struct {
		Enabled     bool   `toml:"enabled"`
		ClientId    string `toml:"client_id"`
		Secret      string `toml:"secret"`
		Url         string `toml:"url"`
		RedirectUri string `toml:"redirect_uri"`
	}

	function struct {
		VerifyJWT *bool  `toml:"verify_jwt"`
		ImportMap string `toml:"import_map"`
	}

	analytics struct {
		Enabled          bool   `toml:"enabled"`
		Port             uint16 `toml:"port"`
		GcpProjectId     string `toml:"gcp_project_id"`
		GcpProjectNumber string `toml:"gcp_project_number"`
		GcpJwtPath       string `toml:"gcp_jwt_path"`
	}

	// TODO
	// scripts struct {
	// 	BeforeMigrations string `toml:"before_migrations"`
	// 	AfterMigrations  string `toml:"after_migrations"`
	// }
)

func LoadConfig() error {
	return LoadConfigFS(afero.NewOsFs())
}

func LoadConfigFS(fsys afero.Fs) error {
	// TODO: provide a config interface for all sub commands to use fsys
	if _, err := toml.DecodeFS(afero.NewIOFS(fsys), ConfigPath, &Config); err != nil {
		CmdSuggestion = fmt.Sprintf("Have you set up the project with %s?", Aqua("supabase init"))
		cwd, osErr := os.Getwd()
		if osErr != nil {
			cwd = "current directory"
		}
		return fmt.Errorf("cannot read config in %s: %w", cwd, err)
	}
	// Load secrets from .env file
	if err := godotenv.Load(); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	if err := viper.Unmarshal(&Config); err != nil {
		return err
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
			RealtimeId = "realtime-dev.supabase_realtime_" + Config.ProjectId
			RestId = "supabase_rest_" + Config.ProjectId
			StorageId = "supabase_storage_" + Config.ProjectId
			ImgProxyId = "storage_imgproxy_" + Config.ProjectId
			DifferId = "supabase_differ_" + Config.ProjectId
			PgmetaId = "supabase_pg_meta_" + Config.ProjectId
			StudioId = "supabase_studio_" + Config.ProjectId
			DenoRelayId = "supabase_deno_relay_" + Config.ProjectId
			LogflareId = "supabase_analytics_" + Config.ProjectId
		}
		if Config.Api.Port == 0 {
			return errors.New("Missing required field in config: api.port")
		}
		if Config.Api.MaxRows == 0 {
			Config.Api.MaxRows = 1000
		}
		if len(Config.Api.Schemas) == 0 {
			Config.Api.Schemas = []string{"public", "storage", "graphql_public"}
		}
		// Append required schemas if they are missing
		Config.Api.Schemas = removeDuplicates(append([]string{"public", "storage"}, Config.Api.Schemas...))
		Config.Api.ExtraSearchPath = removeDuplicates(append([]string{"public"}, Config.Api.ExtraSearchPath...))
		if Config.Db.Port == 0 {
			return errors.New("Missing required field in config: db.port")
		}
		if Config.Db.ShadowPort == 0 {
			Config.Db.ShadowPort = 54320
		}
		switch Config.Db.MajorVersion {
		case 0:
			return errors.New("Missing required field in config: db.major_version")
		case 12:
			return errors.New("Postgres version 12.x is unsupported. To use the CLI, either start a new project or follow project migration steps here: https://supabase.com/docs/guides/database#migrating-between-projects.")
		case 13:
			DbImage = Pg13Image
			InitialSchemaSql = InitialSchemaPg13Sql
		case 14:
			DbImage = Pg14Image
			InitialSchemaSql = InitialSchemaPg14Sql
		case 15:
			DbImage = Pg15Image
			InitialSchemaSql = InitialSchemaPg15Sql
		default:
			return fmt.Errorf("Failed reading config: Invalid %s: %v.", Aqua("db.major_version"), Config.Db.MajorVersion)
		}
		if Config.Studio.Port == 0 {
			return errors.New("Missing required field in config: studio.port")
		}
		if Config.Inbucket.Port == 0 {
			return errors.New("Missing required field in config: inbucket.port")
		}
		if Config.Storage.FileSizeLimit == 0 {
			Config.Storage.FileSizeLimit = 50 * units.MiB
		}
		if Config.Auth.SiteUrl == "" {
			return errors.New("Missing required field in config: auth.site_url")
		}
		if Config.Auth.JwtExpiry == 0 {
			Config.Auth.JwtExpiry = 3600
		}
		if Config.Auth.JwtSecret == "" {
			Config.Auth.JwtSecret = "super-secret-jwt-token-with-at-least-32-characters-long"
		}
		if Config.Auth.AnonKey == "" {
			Config.Auth.AnonKey = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0"
		}
		if Config.Auth.ServiceRoleKey == "" {
			Config.Auth.ServiceRoleKey = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU"
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

				var clientId, secret, redirectUri, url string

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

				if Config.Auth.External[ext].RedirectUri != "" {
					v, err := maybeLoadEnv(Config.Auth.External[ext].RedirectUri)
					if err != nil {
						return err
					}
					redirectUri = v
				}

				if Config.Auth.External[ext].Url != "" {
					v, err := maybeLoadEnv(Config.Auth.External[ext].Url)
					if err != nil {
						return err
					}
					url = v
				}

				Config.Auth.External[ext] = provider{
					Enabled:     true,
					ClientId:    clientId,
					Secret:      secret,
					RedirectUri: redirectUri,
					Url:         url,
				}
			}
		}
	}

	if Config.Functions == nil {
		Config.Functions = map[string]function{}
	}
	for name, functionConfig := range Config.Functions {
		verifyJWT := functionConfig.VerifyJWT

		if verifyJWT == nil {
			x := true
			verifyJWT = &x
		}

		Config.Functions[name] = function{
			VerifyJWT: verifyJWT,
			ImportMap: functionConfig.ImportMap,
		}
	}

	if Config.Analytics.Enabled {
		if Config.Analytics.Port == 0 {
			Config.Analytics.Port = 54327
		}
		if len(Config.Analytics.GcpProjectId) == 0 {
			return errors.New("Missing required field in config: analytics.gcp_project_id")
		}
		if len(Config.Analytics.GcpProjectNumber) == 0 {
			return errors.New("Missing required field in config: analytics.gcp_project_number")
		}
		if len(Config.Analytics.GcpJwtPath) == 0 {
			Config.Analytics.GcpJwtPath = "supabase/gcloud.json"
		}
	}

	return nil
}

func InitConfig(projectId string, fsys afero.Fs) error {
	// Defaults to current directory name as project id
	if len(projectId) == 0 {
		cwd, err := os.Getwd()
		if err != nil {
			return err
		}
		projectId = filepath.Base(cwd)
	}
	// Create config file
	if err := MkdirIfNotExistFS(fsys, filepath.Dir(ConfigPath)); err != nil {
		return err
	}
	f, err := fsys.OpenFile(ConfigPath, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0644)
	if err != nil {
		return err
	}
	defer f.Close()
	// Update from template
	return initConfigTemplate.Execute(f, struct{ ProjectId string }{
		ProjectId: projectId,
	})
}

func WriteConfig(fsys afero.Fs, _test bool) error {
	return InitConfig("", fsys)
}

func removeDuplicates(slice []string) (result []string) {
	set := make(map[string]struct{})
	for _, item := range slice {
		if _, exists := set[item]; !exists {
			set[item] = struct{}{}
			result = append(result, item)
		}
	}
	return result
}
