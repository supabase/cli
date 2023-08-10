package utils

import (
	_ "embed"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"text/template"

	"github.com/BurntSushi/toml"
	"github.com/docker/go-units"
	"github.com/joho/godotenv"
	"github.com/spf13/afero"
	"github.com/spf13/viper"
)

var (
	DbImage       string
	NetId         string
	DbId          string
	ConfigId      string
	KongId        string
	GotrueId      string
	InbucketId    string
	RealtimeId    string
	RestId        string
	StorageId     string
	ImgProxyId    string
	DifferId      string
	PgmetaId      string
	StudioId      string
	EdgeRuntimeId string
	LogflareId    string
	VectorId      string

	InitialSchemaSql string
	//go:embed templates/initial_schemas/13.sql
	InitialSchemaPg13Sql string
	//go:embed templates/initial_schemas/14.sql
	InitialSchemaPg14Sql string
	//go:embed templates/initial_schemas/15.sql
	InitialSchemaPg15Sql string

	//go:embed templates/init_config.toml
	initConfigEmbed    string
	initConfigTemplate = template.Must(template.New("initConfig").Parse(initConfigEmbed))
	invalidProjectId   = regexp.MustCompile("[^a-zA-Z0-9_.-]+")
	envPattern         = regexp.MustCompile(`^env\((.*)\)$`)
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

type LogflareBackend string

const (
	LogflarePostgres LogflareBackend = "postgres"
	LogflareBigQuery LogflareBackend = "bigquery"
)

var Config = config{
	Auth: auth{
		Image: GotrueImage,
		Email: email{
			Template: map[string]emailTemplate{
				"invite":       {},
				"confirmation": {},
				"recovery":     {},
				"magic_link":   {},
				"email_change": {},
			},
		},
		External: map[string]provider{
			"apple":     {},
			"azure":     {},
			"bitbucket": {},
			"discord":   {},
			"facebook":  {},
			"github":    {},
			"gitlab":    {},
			"google":    {},
			"keycloak":  {},
			"linkedin":  {},
			"notion":    {},
			"twitch":    {},
			"twitter":   {},
			"slack":     {},
			"spotify":   {},
			"workos":    {},
			"zoom":      {},
		},
		JwtSecret:      "super-secret-jwt-token-with-at-least-32-characters-long",
		AnonKey:        "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0",
		ServiceRoleKey: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU",
	},
	Db: db{
		Password: "postgres",
	},
	Analytics: analytics{
		ApiKey: "api-key",
		// Defaults to bigquery for backwards compatibility with existing config.toml
		Backend: LogflareBigQuery,
	},
}

// We follow these rules when adding new config:
//  1. Update init_config.toml with the new key, default value, and comments to explain usage.
//  2. Update config struct with new field and toml tag (spelled in snake_case).
//  3. Add custom field validations to LoadConfigFS function for eg. integer range checks.
//
// If you are adding new user defined secrets, such as OAuth provider secret, the default value in
// init_config.toml should be an env var substitution. For example,
//
// > secret = "env(SUPABASE_AUTH_EXTERNAL_APPLE_SECRET)"
//
// If you are adding an internal config or secret that doesn't need to be overridden by the user,
// exclude the field from toml serialization. For example,
//
//	type auth struct {
//		AnonKey string `toml:"-" mapstructure:"anon_key"`
//	}
//
// Use `mapstructure:"anon_key"` tag only if you want inject values from a predictable environment
// variable, such as SUPABASE_AUTH_ANON_KEY.
//
// Default values for internal configs should be added to `var Config` initialiser.
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
		Port         uint   `toml:"port"`
		ShadowPort   uint   `toml:"shadow_port"`
		MajorVersion uint   `toml:"major_version"`
		Password     string `toml:"-"`
	}

	studio struct {
		Enabled bool   `toml:"enabled"`
		Port    uint   `toml:"port"`
		ApiUrl  string `toml:"api_url"`
	}

	inbucket struct {
		Enabled  bool `toml:"enabled"`
		Port     uint `toml:"port"`
		SmtpPort uint `toml:"smtp_port"`
		Pop3Port uint `toml:"pop3_port"`
	}

	storage struct {
		FileSizeLimit sizeInBytes `toml:"file_size_limit"`
	}

	auth struct {
		Image                  string   `toml:"-"`
		SiteUrl                string   `toml:"site_url"`
		AdditionalRedirectUrls []string `toml:"additional_redirect_urls"`

		JwtExpiry                  uint `toml:"jwt_expiry"`
		EnableRefreshTokenRotation bool `toml:"enable_refresh_token_rotation"`
		RefreshTokenReuseInterval  uint `toml:"refresh_token_reuse_interval"`

		EnableSignup bool  `toml:"enable_signup"`
		Email        email `toml:"email"`
		Sms          sms   `toml:"sms"`
		External     map[string]provider

		// Custom secrets can be injected from .env file
		JwtSecret      string `toml:"-" mapstructure:"jwt_secret"`
		AnonKey        string `toml:"-" mapstructure:"anon_key"`
		ServiceRoleKey string `toml:"-" mapstructure:"service_role_key"`
	}

	email struct {
		EnableSignup         bool                     `toml:"enable_signup"`
		DoubleConfirmChanges bool                     `toml:"double_confirm_changes"`
		EnableConfirmations  bool                     `toml:"enable_confirmations"`
		Template             map[string]emailTemplate `toml:"template"`
	}

	emailTemplate struct {
		Subject     string `toml:"subject"`
		ContentPath string `toml:"content_path"`
	}

	sms struct {
		EnableSignup        bool              `toml:"enable_signup"`
		EnableConfirmations bool              `toml:"enable_confirmations"`
		Twilio              twilioConfig      `toml:"twilio" mapstructure:"twilio"`
		Messagebird         messagebirdConfig `toml:"messagebird" mapstructure:"messagebird"`
		Textlocal           textlocalConfig   `toml:"textlocal" mapstructure:"textlocal"`
		Vonage              vonageConfig      `toml:"vonage" mapstructure:"vonage"`
	}

	twilioConfig struct {
		Enabled           bool   `toml:"enabled"`
		AccountSid        string `toml:"account_sid"`
		MessageServiceSid string `toml:"message_service_sid"`
		AuthToken         string `toml:"auth_token" mapstructure:"auth_token"`
	}

	messagebirdConfig struct {
		Enabled    bool   `toml:"enabled"`
		Originator string `toml:"originator"`
		AccessKey  string `toml:"access_key" mapstructure:"access_key"`
	}

	textlocalConfig struct {
		Enabled bool   `toml:"enabled"`
		Sender  string `toml:"sender"`
		ApiKey  string `toml:"api_key" mapstructure:"api_key"`
	}

	vonageConfig struct {
		Enabled   bool   `toml:"enabled"`
		From      string `toml:"from"`
		ApiKey    string `toml:"api_key" mapstructure:"api_key"`
		ApiSecret string `toml:"api_secret" mapstructure:"api_secret"`
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
		Enabled          bool            `toml:"enabled"`
		Port             uint16          `toml:"port"`
		Backend          LogflareBackend `toml:"backend"`
		VectorPort       uint16          `toml:"vector_port"`
		GcpProjectId     string          `toml:"gcp_project_id"`
		GcpProjectNumber string          `toml:"gcp_project_number"`
		GcpJwtPath       string          `toml:"gcp_jwt_path"`
		ApiKey           string          `toml:"-" mapstructure:"api_key"`
	}

	// TODO
	// scripts struct {
	// 	BeforeMigrations string `toml:"before_migrations"`
	// 	AfterMigrations  string `toml:"after_migrations"`
	// }
)

func LoadConfigFS(fsys afero.Fs) error {
	// Load default values
	if _, err := toml.Decode(initConfigEmbed, &Config); err != nil {
		return err
	}
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
			ConfigId = "supabase_config_" + Config.ProjectId
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
			EdgeRuntimeId = "supabase_edge_runtime_" + Config.ProjectId
			LogflareId = "supabase_analytics_" + Config.ProjectId
			VectorId = "supabase_vector_" + Config.ProjectId
		}
		// Validate api config
		if Config.Api.Port == 0 {
			return errors.New("Missing required field in config: api.port")
		}
		// Append required schemas if they are missing
		Config.Api.Schemas = removeDuplicates(append([]string{"public", "storage"}, Config.Api.Schemas...))
		Config.Api.ExtraSearchPath = removeDuplicates(append([]string{"public"}, Config.Api.ExtraSearchPath...))
		// Validate db config
		if Config.Db.Port == 0 {
			return errors.New("Missing required field in config: db.port")
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
		// Validate studio config
		if Config.Studio.Port == 0 {
			return errors.New("Missing required field in config: studio.port")
		}
		// Validate email config
		if Config.Inbucket.Port == 0 {
			return errors.New("Missing required field in config: inbucket.port")
		}
		// Validate auth config
		if Config.Auth.SiteUrl == "" {
			return errors.New("Missing required field in config: auth.site_url")
		}
		if version, err := afero.ReadFile(fsys, GotrueVersionPath); err == nil && len(version) > 0 && Config.Db.MajorVersion > 14 {
			index := strings.IndexByte(GotrueImage, ':')
			Config.Auth.Image = GotrueImage[:index+1] + string(version)
		}
		// Validate email template
		for _, tmpl := range Config.Auth.Email.Template {
			if len(tmpl.ContentPath) > 0 {
				if _, err := fsys.Stat(tmpl.ContentPath); err != nil {
					return err
				}
			}
		}
		// Validate sms config
		var err error
		if Config.Auth.Sms.Twilio.Enabled {
			if len(Config.Auth.Sms.Twilio.AccountSid) == 0 {
				return errors.New("Missing required field in config: auth.sms.twilio.account_sid")
			}
			if len(Config.Auth.Sms.Twilio.MessageServiceSid) == 0 {
				return errors.New("Missing required field in config: auth.sms.twilio.message_service_sid")
			}
			if len(Config.Auth.Sms.Twilio.AuthToken) == 0 {
				return errors.New("Missing required field in config: auth.sms.twilio.auth_token")
			}
			if Config.Auth.Sms.Twilio.AuthToken, err = maybeLoadEnv(Config.Auth.Sms.Twilio.AuthToken); err != nil {
				return err
			}
		}
		if Config.Auth.Sms.Messagebird.Enabled {
			if len(Config.Auth.Sms.Messagebird.Originator) == 0 {
				return errors.New("Missing required field in config: auth.sms.messagebird.originator")
			}
			if len(Config.Auth.Sms.Messagebird.AccessKey) == 0 {
				return errors.New("Missing required field in config: auth.sms.messagebird.access_key")
			}
			if Config.Auth.Sms.Messagebird.AccessKey, err = maybeLoadEnv(Config.Auth.Sms.Messagebird.AccessKey); err != nil {
				return err
			}
		}
		if Config.Auth.Sms.Textlocal.Enabled {
			if len(Config.Auth.Sms.Textlocal.Sender) == 0 {
				return errors.New("Missing required field in config: auth.sms.textlocal.sender")
			}
			if len(Config.Auth.Sms.Textlocal.ApiKey) == 0 {
				return errors.New("Missing required field in config: auth.sms.textlocal.api_key")
			}
			if Config.Auth.Sms.Textlocal.ApiKey, err = maybeLoadEnv(Config.Auth.Sms.Textlocal.ApiKey); err != nil {
				return err
			}
		}
		if Config.Auth.Sms.Vonage.Enabled {
			if len(Config.Auth.Sms.Vonage.From) == 0 {
				return errors.New("Missing required field in config: auth.sms.vonage.from")
			}
			if len(Config.Auth.Sms.Vonage.ApiKey) == 0 {
				return errors.New("Missing required field in config: auth.sms.vonage.api_key")
			}
			if len(Config.Auth.Sms.Vonage.ApiSecret) == 0 {
				return errors.New("Missing required field in config: auth.sms.vonage.api_secret")
			}
			if Config.Auth.Sms.Vonage.ApiKey, err = maybeLoadEnv(Config.Auth.Sms.Vonage.ApiKey); err != nil {
				return err
			}
			if Config.Auth.Sms.Vonage.ApiSecret, err = maybeLoadEnv(Config.Auth.Sms.Vonage.ApiSecret); err != nil {
				return err
			}
		}
		// Validate oauth config
		for ext, provider := range Config.Auth.External {
			if !provider.Enabled {
				continue
			}
			if provider.ClientId == "" {
				return fmt.Errorf("Missing required field in config: auth.external.%s.client_id", ext)
			}
			if provider.Secret == "" {
				return fmt.Errorf("Missing required field in config: auth.external.%s.secret", ext)
			}
			if provider.ClientId, err = maybeLoadEnv(provider.ClientId); err != nil {
				return err
			}
			if provider.Secret, err = maybeLoadEnv(provider.Secret); err != nil {
				return err
			}
			if provider.RedirectUri, err = maybeLoadEnv(provider.RedirectUri); err != nil {
				return err
			}
			if provider.Url, err = maybeLoadEnv(provider.Url); err != nil {
				return err
			}
			Config.Auth.External[ext] = provider
		}
	}
	// Validate functions config
	for name, functionConfig := range Config.Functions {
		if functionConfig.VerifyJWT == nil {
			verifyJWT := true
			functionConfig.VerifyJWT = &verifyJWT
			Config.Functions[name] = functionConfig
		}
	}
	// Validate logflare config
	if Config.Analytics.Enabled {
		switch Config.Analytics.Backend {
		case LogflareBigQuery:
			if len(Config.Analytics.GcpProjectId) == 0 {
				return errors.New("Missing required field in config: analytics.gcp_project_id")
			}
			if len(Config.Analytics.GcpProjectNumber) == 0 {
				return errors.New("Missing required field in config: analytics.gcp_project_number")
			}
			if len(Config.Analytics.GcpJwtPath) == 0 {
				return errors.New("Path to GCP Service Account Key must be provided in config, relative to config.toml: analytics.gcp_jwt_path")
			}
		case LogflarePostgres:
			break
		default:
			allowed := []LogflareBackend{LogflarePostgres, LogflareBigQuery}
			return fmt.Errorf("Invalid config for analytics.backend. Must be one of: %v", allowed)
		}
	}
	return nil
}

func maybeLoadEnv(s string) (string, error) {
	matches := envPattern.FindStringSubmatch(s)
	if len(matches) == 0 {
		return s, nil
	}

	envName := matches[1]
	if value := os.Getenv(envName); value != "" {
		return value, nil
	}

	return "", fmt.Errorf(`Error evaluating "env(%s)": environment variable %s is unset.`, s, envName)
}

func sanitizeProjectId(src string) string {
	// A valid project ID must only contain alphanumeric and special characters _.-
	sanitized := invalidProjectId.ReplaceAllString(src, "_")
	// It must also start with an alphanumeric character
	return strings.TrimLeft(sanitized, "_.-")
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
	projectId = sanitizeProjectId(projectId)
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
