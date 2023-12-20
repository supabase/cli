package utils

import (
	"bytes"
	_ "embed"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"text/template"
	"time"

	"github.com/BurntSushi/toml"
	"github.com/docker/go-units"
	"github.com/go-errors/errors"
	"github.com/golang-jwt/jwt/v5"
	"github.com/joho/godotenv"
	"github.com/spf13/afero"
	"github.com/spf13/viper"
)

var (
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
	PoolerId      string

	DbAliases          = []string{"db", "db.supabase.internal"}
	KongAliases        = []string{"kong", "api.supabase.internal"}
	GotrueAliases      = []string{"auth"}
	InbucketAliases    = []string{"inbucket"}
	RealtimeAliases    = []string{"realtime"}
	RestAliases        = []string{"rest"}
	StorageAliases     = []string{"storage"}
	ImgProxyAliases    = []string{"imgproxy"}
	PgmetaAliases      = []string{"pg_meta"}
	StudioAliases      = []string{"studio"}
	EdgeRuntimeAliases = []string{"edge_runtime"}
	LogflareAliases    = []string{"analytics"}
	VectorAliases      = []string{"vector"}
	PoolerAliases      = []string{"pooler"}

	InitialSchemaSql string
	//go:embed templates/initial_schemas/13.sql
	InitialSchemaPg13Sql string
	//go:embed templates/initial_schemas/14.sql
	InitialSchemaPg14Sql string

	//go:embed templates/init_config.toml
	initConfigEmbed    string
	initConfigTemplate = template.Must(template.New("initConfig").Parse(initConfigEmbed))
	invalidProjectId   = regexp.MustCompile("[^a-zA-Z0-9_.-]+")
	envPattern         = regexp.MustCompile(`^env\((.*)\)$`)
)

func GetId(name string) string {
	return "supabase_" + name + "_" + Config.ProjectId
}

func UpdateDockerIds() {
	NetId = GetId("network")
	DbId = GetId(DbAliases[0])
	ConfigId = GetId("config")
	KongId = GetId(KongAliases[0])
	GotrueId = GetId(GotrueAliases[0])
	InbucketId = GetId(InbucketAliases[0])
	RealtimeId = "realtime-dev." + GetId(RealtimeAliases[0])
	RestId = GetId(RestAliases[0])
	StorageId = GetId(StorageAliases[0])
	ImgProxyId = "storage_" + ImgProxyAliases[0] + "_" + Config.ProjectId
	DifferId = GetId("differ")
	PgmetaId = GetId(PgmetaAliases[0])
	StudioId = GetId(StudioAliases[0])
	EdgeRuntimeId = GetId(EdgeRuntimeAliases[0])
	LogflareId = GetId(LogflareAliases[0])
	VectorId = GetId(VectorAliases[0])
	PoolerId = GetId(PoolerAliases[0])
}

// Type for turning human-friendly bytes string ("5MB", "32kB") into an int64 during toml decoding.
type sizeInBytes int64

func (s *sizeInBytes) UnmarshalText(text []byte) error {
	size, err := units.RAMInBytes(string(text))
	if err == nil {
		*s = sizeInBytes(size)
	}
	return err
}

func (s sizeInBytes) MarshalText() (text []byte, err error) {
	return []byte(units.BytesSize(float64(s))), nil
}

type LogflareBackend string

const (
	LogflarePostgres LogflareBackend = "postgres"
	LogflareBigQuery LogflareBackend = "bigquery"
)

type PoolMode string

const (
	TransactionMode PoolMode = "transaction"
	SessionMode     PoolMode = "session"
)

type AddressFamily string

const (
	AddressIPv6 AddressFamily = "IPv6"
	AddressIPv4 AddressFamily = "IPv4"
)

type CustomClaims struct {
	// Overrides Issuer to maintain json order when marshalling
	Issuer string `json:"iss,omitempty"`
	Ref    string `json:"ref,omitempty"`
	Role   string `json:"role"`
	jwt.RegisteredClaims
}

const (
	defaultJwtSecret = "super-secret-jwt-token-with-at-least-32-characters-long"
	defaultJwtExpiry = 1983812996
)

func (c CustomClaims) NewToken() *jwt.Token {
	if c.ExpiresAt == nil {
		c.ExpiresAt = jwt.NewNumericDate(time.Unix(defaultJwtExpiry, 0))
	}
	if len(c.Issuer) == 0 {
		c.Issuer = "supabase-demo"
	}
	return jwt.NewWithClaims(jwt.SigningMethodHS256, c)
}

var Config = config{
	Api: api{
		Image: PostgrestImage,
	},
	Db: db{
		Image:    Pg15Image,
		Password: "postgres",
		RootKey:  "d4dc5b6d4a1d6a10b2c1e76112c994d65db7cec380572cc1839624d4be3fa275",
	},
	Realtime: realtime{
		IpVersion: AddressIPv6,
	},
	Storage: storage{
		Image: StorageImage,
	},
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
		Sms: sms{
			Template: "Your code is {{ .Code }} .",
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
		JwtExpiry: 3600,
		JwtSecret: defaultJwtSecret,
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
// Default values for internal configs should be added to `var Config` initializer.
type (
	config struct {
		ProjectId    string              `toml:"project_id"`
		Api          api                 `toml:"api"`
		Db           db                  `toml:"db" mapstructure:"db"`
		Realtime     realtime            `toml:"realtime"`
		Studio       studio              `toml:"studio"`
		Inbucket     inbucket            `toml:"inbucket"`
		Storage      storage             `toml:"storage"`
		Auth         auth                `toml:"auth" mapstructure:"auth"`
		Functions    map[string]function `toml:"functions"`
		Analytics    analytics           `toml:"analytics"`
		Experimental experimental        `toml:"experimental" mapstructure:"-"`
		// TODO
		// Scripts   scripts
	}

	api struct {
		Enabled         bool     `toml:"enabled"`
		Image           string   `toml:"-"`
		Port            uint     `toml:"port"`
		Schemas         []string `toml:"schemas"`
		ExtraSearchPath []string `toml:"extra_search_path"`
		MaxRows         uint     `toml:"max_rows"`
	}

	db struct {
		Image        string `toml:"-"`
		Port         uint   `toml:"port"`
		ShadowPort   uint   `toml:"shadow_port"`
		MajorVersion uint   `toml:"major_version"`
		Password     string `toml:"-"`
		RootKey      string `toml:"-" mapstructure:"root_key"`
		Pooler       pooler `toml:"pooler"`
	}

	pooler struct {
		Enabled         bool     `toml:"enabled"`
		Port            uint16   `toml:"port"`
		PoolMode        PoolMode `toml:"pool_mode"`
		DefaultPoolSize uint     `toml:"default_pool_size"`
		MaxClientConn   uint     `toml:"max_client_conn"`
	}

	realtime struct {
		Enabled   bool          `toml:"enabled"`
		IpVersion AddressFamily `toml:"ip_version"`
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
		Enabled       bool        `toml:"enabled"`
		Image         string      `toml:"-"`
		FileSizeLimit sizeInBytes `toml:"file_size_limit"`
	}

	auth struct {
		Enabled                bool     `toml:"enabled"`
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
		Template            string            `toml:"template"`
		Twilio              twilioConfig      `toml:"twilio" mapstructure:"twilio"`
		TwilioVerify        twilioConfig      `toml:"twilio_verify" mapstructure:"twilio_verify"`
		Messagebird         messagebirdConfig `toml:"messagebird" mapstructure:"messagebird"`
		Textlocal           textlocalConfig   `toml:"textlocal" mapstructure:"textlocal"`
		Vonage              vonageConfig      `toml:"vonage" mapstructure:"vonage"`
		TestOTP             map[string]string `toml:"test_otp"`
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

	experimental struct {
		OrioleDBVersion string `toml:"orioledb_version"`
		S3Host          string `toml:"s3_host"`
		S3Region        string `toml:"s3_region"`
		S3AccessKey     string `toml:"s3_access_key"`
		S3SecretKey     string `toml:"s3_secret_key"`
	}

	// TODO
	// scripts struct {
	// 	BeforeMigrations string `toml:"before_migrations"`
	// 	AfterMigrations  string `toml:"after_migrations"`
	// }
)

func LoadConfigFS(fsys afero.Fs) error {
	// Load default values
	var buf bytes.Buffer
	if err := initConfigTemplate.Execute(&buf, nil); err != nil {
		return errors.Errorf("failed to initialise config template: %w", err)
	}
	dec := toml.NewDecoder(&buf)
	if _, err := dec.Decode(&Config); err != nil {
		return errors.Errorf("failed to decode config template: %w", err)
	}
	// Load user defined config
	if metadata, err := toml.DecodeFS(afero.NewIOFS(fsys), ConfigPath, &Config); err != nil {
		CmdSuggestion = fmt.Sprintf("Have you set up the project with %s?", Aqua("supabase init"))
		cwd, osErr := os.Getwd()
		if osErr != nil {
			cwd = "current directory"
		}
		return errors.Errorf("cannot read config in %s: %w", Bold(cwd), err)
	} else if undecoded := metadata.Undecoded(); len(undecoded) > 0 {
		fmt.Fprintf(os.Stderr, "Unknown config fields: %+v\n", undecoded)
	}
	// Load secrets from .env file
	if err := godotenv.Load(); err != nil && !errors.Is(err, os.ErrNotExist) {
		return errors.Errorf("failed to load %s: %w", Bold(".env"), err)
	}
	if err := viper.Unmarshal(&Config); err != nil {
		return errors.Errorf("failed to parse env to config: %w", err)
	}

	// Generate JWT tokens
	if len(Config.Auth.AnonKey) == 0 {
		anonToken := CustomClaims{Role: "anon"}.NewToken()
		if signed, err := anonToken.SignedString([]byte(Config.Auth.JwtSecret)); err != nil {
			return errors.Errorf("failed to generate anon key: %w", err)
		} else {
			Config.Auth.AnonKey = signed
		}
	}
	if len(Config.Auth.ServiceRoleKey) == 0 {
		anonToken := CustomClaims{Role: "service_role"}.NewToken()
		if signed, err := anonToken.SignedString([]byte(Config.Auth.JwtSecret)); err != nil {
			return errors.Errorf("failed to generate service_role key: %w", err)
		} else {
			Config.Auth.ServiceRoleKey = signed
		}
	}

	// Process decoded TOML.
	{
		if Config.ProjectId == "" {
			return errors.New("Missing required field in config: project_id")
		}
		UpdateDockerIds()
		// Validate api config
		if Config.Api.Port == 0 {
			return errors.New("Missing required field in config: api.port")
		}
		if Config.Api.Enabled {
			if version, err := afero.ReadFile(fsys, RestVersionPath); err == nil && len(version) > 0 && Config.Db.MajorVersion > 14 {
				index := strings.IndexByte(PostgrestImage, ':')
				Config.Api.Image = PostgrestImage[:index+1] + string(version)
			}
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
			Config.Db.Image = Pg13Image
			InitialSchemaSql = InitialSchemaPg13Sql
		case 14:
			Config.Db.Image = Pg14Image
			InitialSchemaSql = InitialSchemaPg14Sql
		case 15:
			if len(Config.Experimental.OrioleDBVersion) > 0 {
				Config.Db.Image = "supabase/postgres:orioledb-" + Config.Experimental.OrioleDBVersion
				var err error
				if Config.Experimental.S3Host, err = maybeLoadEnv(Config.Experimental.S3Host); err != nil {
					return err
				}
				if Config.Experimental.S3Region, err = maybeLoadEnv(Config.Experimental.S3Region); err != nil {
					return err
				}
				if Config.Experimental.S3AccessKey, err = maybeLoadEnv(Config.Experimental.S3AccessKey); err != nil {
					return err
				}
				if Config.Experimental.S3SecretKey, err = maybeLoadEnv(Config.Experimental.S3SecretKey); err != nil {
					return err
				}
			} else if version, err := afero.ReadFile(fsys, PostgresVersionPath); err == nil && len(version) > 0 {
				index := strings.IndexByte(Pg15Image, ':')
				Config.Db.Image = Pg15Image[:index+1] + string(version)
			}
		default:
			return errors.Errorf("Failed reading config: Invalid %s: %v.", Aqua("db.major_version"), Config.Db.MajorVersion)
		}
		// Validate pooler config
		if Config.Db.Pooler.Enabled {
			allowed := []PoolMode{TransactionMode, SessionMode}
			if !SliceContains(allowed, Config.Db.Pooler.PoolMode) {
				return errors.Errorf("Invalid config for db.pooler.pool_mode. Must be one of: %v", allowed)
			}
		}
		// Validate realtime config
		if Config.Realtime.Enabled {
			allowed := []AddressFamily{AddressIPv6, AddressIPv4}
			if !SliceContains(allowed, Config.Realtime.IpVersion) {
				return errors.Errorf("Invalid config for realtime.ip_version. Must be one of: %v", allowed)
			}
		}
		// Validate storage config
		if Config.Storage.Enabled {
			if version, err := afero.ReadFile(fsys, StorageVersionPath); err == nil && len(version) > 0 && Config.Db.MajorVersion > 14 {
				index := strings.IndexByte(StorageImage, ':')
				Config.Storage.Image = StorageImage[:index+1] + string(version)
			}
		}
		// Validate studio config
		if Config.Studio.Enabled {
			if Config.Studio.Port == 0 {
				return errors.New("Missing required field in config: studio.port")
			}
		}
		// Validate email config
		if Config.Inbucket.Enabled {
			if Config.Inbucket.Port == 0 {
				return errors.New("Missing required field in config: inbucket.port")
			}
		}
		// Validate auth config
		if Config.Auth.Enabled {
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
						return errors.Errorf("failed to read file info: %w", err)
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
			if Config.Auth.Sms.TwilioVerify.Enabled {
				if len(Config.Auth.Sms.TwilioVerify.AccountSid) == 0 {
					return errors.New("Missing required field in config: auth.sms.twilio_verify.account_sid")
				}
				if len(Config.Auth.Sms.TwilioVerify.MessageServiceSid) == 0 {
					return errors.New("Missing required field in config: auth.sms.twilio_verify.message_service_sid")
				}
				if len(Config.Auth.Sms.TwilioVerify.AuthToken) == 0 {
					return errors.New("Missing required field in config: auth.sms.twilio_verify.auth_token")
				}
				if Config.Auth.Sms.TwilioVerify.AuthToken, err = maybeLoadEnv(Config.Auth.Sms.TwilioVerify.AuthToken); err != nil {
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
					return errors.Errorf("Missing required field in config: auth.external.%s.client_id", ext)
				}
				if provider.Secret == "" {
					return errors.Errorf("Missing required field in config: auth.external.%s.secret", ext)
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
			return errors.Errorf("Invalid config for analytics.backend. Must be one of: %v", allowed)
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

	return "", errors.Errorf(`Error evaluating "%s": environment variable %s is unset.`, s, envName)
}

func sanitizeProjectId(src string) string {
	// A valid project ID must only contain alphanumeric and special characters _.-
	sanitized := invalidProjectId.ReplaceAllString(src, "_")
	// It must also start with an alphanumeric character
	return strings.TrimLeft(sanitized, "_.-")
}

type InitParams struct {
	ProjectId   string
	UseOrioleDB bool
}

func InitConfig(params InitParams, fsys afero.Fs) error {
	// Defaults to current directory name as project id
	if len(params.ProjectId) == 0 {
		cwd, err := os.Getwd()
		if err != nil {
			return errors.Errorf("failed to get working directory: %w", err)
		}
		params.ProjectId = filepath.Base(cwd)
	}
	params.ProjectId = sanitizeProjectId(params.ProjectId)
	// Create config file
	if err := MkdirIfNotExistFS(fsys, filepath.Dir(ConfigPath)); err != nil {
		return err
	}
	f, err := fsys.OpenFile(ConfigPath, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0644)
	if err != nil {
		return errors.Errorf("failed to create config file: %w", err)
	}
	defer f.Close()
	// Update from template
	if err := initConfigTemplate.Execute(f, params); err != nil {
		return errors.Errorf("failed to initialise config: %w", err)
	}
	return nil
}

func WriteConfig(fsys afero.Fs, _test bool) error {
	return InitConfig(InitParams{}, fsys)
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
