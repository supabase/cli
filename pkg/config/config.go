package config

import (
	"bytes"
	"context"
	_ "embed"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"io/fs"
	"maps"
	"net"
	"net/http"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"reflect"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"text/template"
	"time"

	"github.com/BurntSushi/toml"
	"github.com/docker/go-units"
	"github.com/go-errors/errors"
	"github.com/go-playground/locales/en"
	ut "github.com/go-playground/universal-translator"
	"github.com/go-playground/validator/v10"
	"github.com/golang-jwt/jwt/v5"
	"github.com/joho/godotenv"
	"github.com/spf13/viper"
	"golang.org/x/mod/semver"

	"github.com/supabase/cli/pkg/fetcher"
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

type RequestPolicy string

const (
	PolicyPerWorker RequestPolicy = "per_worker"
	PolicyOneshot   RequestPolicy = "oneshot"
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

// Regular expression to match strings in the form env(SOMETHING)
var envPattern = regexp.MustCompile(`^env\((\w+)\)$`)

var (
	validate   *validator.Validate
	translator ut.Translator
)

// We follow these rules when adding new config:
//  1. Update init_config.toml (and init_config.test.toml) with the new key, default value, and comments to explain usage.
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
	// Common config fields between our "base" config and any "remote" branch specific
	baseConfig struct {
		ProjectId    string         `toml:"project_id" validate:"required,project_id"`
		Hostname     string         `toml:"-" validate:"required,hostname|ip"`
		Api          api            `toml:"api" validate:"required"`
		Db           db             `toml:"db" mapstructure:"db" validate:"required"`
		Realtime     realtime       `toml:"realtime" validate:"required"`
		Studio       studio         `toml:"studio" validate:"required"`
		Inbucket     inbucket       `toml:"inbucket" validate:"required"`
		Storage      storage        `toml:"storage" validate:"required"`
		Auth         auth           `toml:"auth" mapstructure:"auth" validate:"required"`
		EdgeRuntime  edgeRuntime    `toml:"edge_runtime" validate:"required"`
		Functions    FunctionConfig `toml:"functions" validate:"required"`
		Analytics    analytics      `toml:"analytics" validate:"required"`
		Experimental experimental   `toml:"experimental" mapstructure:"-" validate:"omitempty"`
	}

	config struct {
		baseConfig
		Overrides map[string]interface{} `toml:"remotes" validate:"dive"`
		Remotes   map[string]baseConfig  `toml:"-" validate:"dive"`
	}

	api struct {
		Enabled         bool     `toml:"enabled" validate:"required"`
		Image           string   `toml:"-" validate:"required"`
		KongImage       string   `toml:"-" validate:"required"`
		Port            uint16   `toml:"port" validate:"required_if=Enabled true,gt=0,lt=65536"`
		Schemas         []string `toml:"schemas" validate:"required_if=Enabled true,min=1,dive,required"`
		ExtraSearchPath []string `toml:"extra_search_path" validate:"required_if=Enabled true,dive"`
		MaxRows         uint     `toml:"max_rows" validate:"required_if=Enabled true,gte=0"`
		Tls             tlsKong  `toml:"tls" validate:"required_if=Enabled true"`
		// TODO: replace [auth|studio].api_url
		ExternalUrl string `toml:"external_url" validate:"required_if=Enabled true,url"`
	}

	tlsKong struct {
		Enabled bool `toml:"enabled" validate:"required"`
	}

	db struct {
		Image        string `toml:"-" validate:"required"`
		Port         uint16 `toml:"port" validate:"required,gt=0,lt=65536"`
		ShadowPort   uint16 `toml:"shadow_port" validate:"required,gt=0,lt=65536"`
		MajorVersion uint   `toml:"major_version" validate:"required,db_major_version,oneof=13 14 15"`
		Password     string `toml:"-" validate:"required"`
		RootKey      string `toml:"-" mapstructure:"root_key" validate:"required"`
		Pooler       pooler `toml:"pooler" validate:"required"`
		Seed         seed   `toml:"seed" validate:"required"`
	}

	seed struct {
		Enabled      bool     `toml:"enabled" validate:"required"`
		GlobPatterns []string `toml:"sql_paths" validate:"dive,required"`
		SqlPaths     []string `toml:"-" validate:"dive,required"`
	}

	pooler struct {
		Enabled          bool     `toml:"enabled" validate:"required"`
		Image            string   `toml:"-" validate:"required"`
		Port             uint16   `toml:"port" validate:"required_if=Enabled true,gt=0,lt=65536"`
		PoolMode         PoolMode `toml:"pool_mode" validate:"required_if=Enabled true,oneof=transaction session"`
		DefaultPoolSize  uint     `toml:"default_pool_size" validate:"gte=0"`
		MaxClientConn    uint     `toml:"max_client_conn" validate:"gte=0"`
		ConnectionString string   `toml:"-" validate:"required_if=Enabled true"`
		TenantId         string   `toml:"-" validate:"required_if=Enabled true"`
		EncryptionKey    string   `toml:"-" validate:"required_if=Enabled true,min=32"`
		SecretKeyBase    string   `toml:"-" validate:"required_if=Enabled true,min=32"`
	}

	realtime struct {
		Enabled         bool          `toml:"enabled" validate:"required"`
		Image           string        `toml:"-" validate:"required"`
		IpVersion       AddressFamily `toml:"ip_version" validate:"required_if=Enabled true,oneof=IPv4 IPv6"`
		MaxHeaderLength uint          `toml:"max_header_length" validate:"required,gt=0"`
		TenantId        string        `toml:"-"  validate:"required_if=Enabled true"`
		EncryptionKey   string        `toml:"-"  validate:"required_if=Enabled true,min=16"`
		SecretKeyBase   string        `toml:"-"  validate:"required_if=Enabled true,min=32"`
	}

	studio struct {
		Enabled      bool   `toml:"enabled" validate:"required"`
		Image        string `toml:"-" validate:"required"`
		Port         uint16 `toml:"port" validate:"required_if=Enabled true,gt=0,lt=65536"`
		ApiUrl       string `toml:"api_url" validate:"omitempty,url"`
		OpenaiApiKey string `toml:"openai_api_key" validate:"omitempty,env_or_string"`
		PgmetaImage  string `toml:"-" validate:"required"`
	}

	inbucket struct {
		Enabled  bool   `toml:"enabled" validate:"required"`
		Image    string `toml:"-" validate:"required"`
		Port     uint16 `toml:"port" validate:"required,gt=0,lt=65536"`
		SmtpPort uint16 `toml:"smtp_port" validate:"required,gt=0,lt=65536"`
		Pop3Port uint16 `toml:"pop3_port" validate:"required,gt=0,lt=65536"`
	}

	storage struct {
		Enabled             bool                 `toml:"enabled" validate:"required"`
		Image               string               `toml:"-" validate:"required"`
		FileSizeLimit       sizeInBytes          `toml:"file_size_limit" validate:"required,gt=0"`
		S3Credentials       storageS3Credentials `toml:"-" validate:"required"`
		ImageTransformation imageTransformation  `toml:"image_transformation" validate:"required"`
		Buckets             BucketConfig         `toml:"buckets" validate:"dive,keys,bucket_name,required,endkeys"`
	}

	BucketConfig map[string]bucket

	bucket struct {
		Public           *bool       `toml:"public" validate:"required"`
		FileSizeLimit    sizeInBytes `toml:"file_size_limit" validate:"required,gt=0"`
		AllowedMimeTypes []string    `toml:"allowed_mime_types" validate:"dive,required"`
		ObjectsPath      string      `toml:"objects_path" validate:"required"`
	}

	imageTransformation struct {
		Enabled bool   `toml:"enabled" validate:"required"`
		Image   string `toml:"-" validate:"required"`
	}

	storageS3Credentials struct {
		AccessKeyId     string `toml:"-" validate:"required"`
		SecretAccessKey string `toml:"-" validate:"required"`
		Region          string `toml:"-" validate:"required"`
	}

	auth struct {
		Enabled                bool     `toml:"enabled" validate:"required"`
		Image                  string   `toml:"-" validate:"required"`
		SiteUrl                string   `toml:"site_url" validate:"required,url,env_or_string"`
		AdditionalRedirectUrls []string `toml:"additional_redirect_urls" validate:"dive,url"`

		JwtExpiry                  uint `toml:"jwt_expiry" validate:"required,gt=0"`
		EnableRefreshTokenRotation bool `toml:"enable_refresh_token_rotation" validate:"required"`
		RefreshTokenReuseInterval  uint `toml:"refresh_token_reuse_interval" validate:"gte=0"`
		EnableManualLinking        bool `toml:"enable_manual_linking" validate:"required"`

		Hook     hook     `toml:"hook" validate:"required"`
		MFA      mfa      `toml:"mfa" validate:"required"`
		Sessions sessions `toml:"sessions" validate:"required"`

		EnableSignup           bool                `toml:"enable_signup" validate:"required"`
		EnableAnonymousSignIns bool                `toml:"enable_anonymous_sign_ins" validate:"required"`
		Email                  email               `toml:"email" validate:"required"`
		Sms                    sms                 `toml:"sms" validate:"required"`
		External               map[string]provider `validate:"dive,keys,required,endkeys"`

		// Custom secrets can be injected from .env file
		JwtSecret      string `toml:"-" mapstructure:"jwt_secret" validate:"required,min=32"`
		AnonKey        string `toml:"-" mapstructure:"anon_key" validate:"required"`
		ServiceRoleKey string `toml:"-" mapstructure:"service_role_key" validate:"required"`

		ThirdParty thirdParty `toml:"third_party" validate:"required,third_party"`
	}

	thirdParty struct {
		Firebase tpaFirebase `toml:"firebase" validate:"dive"`
		Auth0    tpaAuth0    `toml:"auth0" validate:"dive"`
		Cognito  tpaCognito  `toml:"aws_cognito" validate:"dive"`
		// Validate the whole struct
		// Use a "-" tag to avoid conflict with the field validations
	}

	tpaFirebase struct {
		Enabled   bool   `toml:"enabled" validate:"required"`
		ProjectID string `toml:"project_id" validate:"required"`
	}

	tpaAuth0 struct {
		Enabled      bool   `toml:"enabled" validate:"required"`
		Tenant       string `toml:"tenant" validate:"required"`
		TenantRegion string `toml:"tenant_region" validate:"required"`
	}

	tpaCognito struct {
		Enabled        bool   `toml:"enabled" validate:"required"`
		UserPoolID     string `toml:"user_pool_id" validate:"required"`
		UserPoolRegion string `toml:"user_pool_region" validate:"required"`
	}

	email struct {
		EnableSignup         bool                     `toml:"enable_signup" validate:"required"`
		DoubleConfirmChanges bool                     `toml:"double_confirm_changes" validate:"required"`
		EnableConfirmations  bool                     `toml:"enable_confirmations" validate:"required"`
		SecurePasswordChange bool                     `toml:"secure_password_change" validate:"required"`
		Template             map[string]emailTemplate `toml:"template" validate:"dive,keys,required,endkeys"`
		Smtp                 smtp                     `toml:"smtp" validate:"required"`
		MaxFrequency         time.Duration            `toml:"max_frequency" validate:"required"`
	}

	smtp struct {
		Host         string        `toml:"host" validate:"required"`
		Port         uint16        `toml:"port" validate:"required,gt=0,lt=65536"`
		User         string        `toml:"user" validate:"required"`
		Pass         string        `toml:"pass" validate:"required"`
		AdminEmail   string        `toml:"admin_email" validate:"required,email"`
		SenderName   string        `toml:"sender_name" validate:"required"`
		MaxFrequency time.Duration `toml:"max_frequency" validate:"required"`
	}

	emailTemplate struct {
		Subject     string `toml:"subject" validate:"required"`
		ContentPath string `toml:"content_path" validate:"required,file"`
	}

	sms struct {
		EnableSignup        bool              `toml:"enable_signup" validate:"required"`
		EnableConfirmations bool              `toml:"enable_confirmations" validate:"required"`
		Template            string            `toml:"template" validate:"required"`
		Twilio              twilioConfig      `toml:"twilio" mapstructure:"twilio" validate:"required"`
		TwilioVerify        twilioConfig      `toml:"twilio_verify" mapstructure:"twilio_verify" validate:"required"`
		Messagebird         messagebirdConfig `toml:"messagebird" mapstructure:"messagebird" validate:"required"`
		Textlocal           textlocalConfig   `toml:"textlocal" mapstructure:"textlocal" validate:"required"`
		Vonage              vonageConfig      `toml:"vonage" mapstructure:"vonage" validate:"required"`
		TestOTP             map[string]string `toml:"test_otp" validate:"dive,keys,required,endkeys,required"`
		MaxFrequency        time.Duration     `toml:"max_frequency" validate:"required"`
	}

	hook struct {
		MFAVerificationAttempt      hookConfig `toml:"mfa_verification_attempt" validate:"dive,hook_config"`
		PasswordVerificationAttempt hookConfig `toml:"password_verification_attempt" validate:"required"`
		CustomAccessToken           hookConfig `toml:"custom_access_token" validate:"required"`
		SendSMS                     hookConfig `toml:"send_sms" validate:"required"`
		SendEmail                   hookConfig `toml:"send_email" validate:"required"`
	}
	factorTypeConfiguration struct {
		EnrollEnabled bool `toml:"enroll_enabled" validate:"required"`
		VerifyEnabled bool `toml:"verify_enabled" validate:"required"`
	}
	phoneFactorTypeConfiguration struct {
		factorTypeConfiguration
		OtpLength    uint          `toml:"otp_length" validate:"required,gt=0"`
		Template     string        `toml:"template" validate:"required"`
		MaxFrequency time.Duration `toml:"max_frequency" validate:"required"`
	}

	mfa struct {
		TOTP               factorTypeConfiguration      `toml:"totp" validate:"required"`
		Phone              phoneFactorTypeConfiguration `toml:"phone" validate:"required"`
		MaxEnrolledFactors uint                         `toml:"max_enrolled_factors" validate:"required,gte=0"`
	}

	hookConfig struct {
		Enabled bool   `toml:"enabled" validate:"required"`
		URI     string `toml:"uri" validate:"required_if=Enabled true"`
		Secrets string `toml:"secrets" validate:"env_or_string"`
	}

	sessions struct {
		Timebox           time.Duration `toml:"timebox" validate:"required"`
		InactivityTimeout time.Duration `toml:"inactivity_timeout" validate:"required"`
	}

	twilioConfig struct {
		Enabled           bool   `toml:"enabled" validate:"required"`
		AccountSid        string `toml:"account_sid" validate:"required_if=Enabled true,env_or_string"`
		MessageServiceSid string `toml:"message_service_sid" validate:"required_if=Enabled true,env_or_string"`
		AuthToken         string `toml:"auth_token" validate:"required_if=Enabled true,env_or_string"`
	}

	messagebirdConfig struct {
		Enabled    bool   `toml:"enabled" validate:"required"`
		Originator string `toml:"originator" validate:"required"`
		AccessKey  string `toml:"access_key" mapstructure:"access_key" validate:"required"`
	}

	textlocalConfig struct {
		Enabled bool   `toml:"enabled" validate:"required"`
		Sender  string `toml:"sender" validate:"required"`
		ApiKey  string `toml:"api_key" mapstructure:"api_key" validate:"required"`
	}

	vonageConfig struct {
		Enabled   bool   `toml:"enabled" validate:"required"`
		From      string `toml:"from" validate:"required"`
		ApiKey    string `toml:"api_key" mapstructure:"api_key" validate:"required"`
		ApiSecret string `toml:"api_secret" mapstructure:"api_secret" validate:"required"`
	}

	provider struct {
		Enabled        bool   `toml:"enabled" validate:"required"`
		ClientId       string `validate:"required_if=Enabled true,env_or_string"`
		Secret         string `validate:"required_if=Enabled true,env_or_string"`
		RedirectUri    string `validate:"omitempty,url,env_or_string"`
		Url            string `validate:"omitempty,url,env_or_string"`
		SkipNonceCheck bool   `toml:"skip_nonce_check" validate:"omitempty"`
	}

	edgeRuntime struct {
		Enabled       bool          `toml:"enabled" validate:"required"`
		Image         string        `toml:"-" validate:"required"`
		Policy        RequestPolicy `toml:"policy" validate:"required,oneof=per_worker oneshot"`
		InspectorPort uint16        `toml:"inspector_port" validate:"gt=0,lt=65536"`
	}

	FunctionConfig map[string]function

	function struct {
		Enabled    *bool  `toml:"enabled" validate:"required"`
		VerifyJWT  *bool  `toml:"verify_jwt" json:"verifyJWT" validate:"required"`
		ImportMap  string `toml:"import_map" json:"importMapPath,omitempty" validate:"omitempty,file"`
		Entrypoint string `json:"-" validate:"omitempty"`
	}

	analytics struct {
		Enabled          bool            `toml:"enabled" validate:"required"`
		Image            string          `toml:"-" validate:"required"`
		VectorImage      string          `toml:"-" validate:"required"`
		Port             uint16          `toml:"port" validate:"required_if=Enabled true,gt=0,lt=65536"`
		Backend          LogflareBackend `toml:"backend" validate:"required_if=Enabled true,oneof=postgres bigquery"`
		GcpProjectId     string          `toml:"gcp_project_id" validate:"required_if=Backend bigquery"`
		GcpProjectNumber string          `toml:"gcp_project_number" validate:"required_if=Backend bigquery"`
		GcpJwtPath       string          `toml:"gcp_jwt_path" validate:"required_if=Backend bigquery,file"`
		ApiKey           string          `toml:"-" mapstructure:"api_key" validate:"omitempty"`
		// Deprecated together with syslog
		VectorPort uint16 `toml:"vector_port" validate:"gte=0,lt=65536"`
	}
	experimental struct {
		OrioleDBVersion string `toml:"orioledb_version" validate:"omitempty"`
		S3Host          string `toml:"s3_host" validate:"required_if=OrioleDBVersion !='',env_or_string,hostname|ip|url"`
		S3Region        string `toml:"s3_region" validate:"required_if=OrioleDBVersion !='',env_or_string"`
		S3AccessKey     string `toml:"s3_access_key" validate:"required_if=OrioleDBVersion !='',env_or_string"`
		S3SecretKey     string `toml:"s3_secret_key" validate:"required_if=OrioleDBVersion !='',env_or_string"`
	}
)

func (c *baseConfig) Clone() baseConfig {
	copy := *c
	copy.Storage.Buckets = maps.Clone(c.Storage.Buckets)
	copy.Functions = maps.Clone(c.Functions)
	copy.Auth.External = maps.Clone(c.Auth.External)
	copy.Auth.Email.Template = maps.Clone(c.Auth.Email.Template)
	copy.Auth.Sms.TestOTP = maps.Clone(c.Auth.Sms.TestOTP)
	return copy
}

type ConfigEditor func(*config)

func WithHostname(hostname string) ConfigEditor {
	return func(c *config) {
		c.Hostname = hostname
	}
}

func NewConfig(editors ...ConfigEditor) config {
	initial := config{baseConfig: baseConfig{
		Hostname: "127.0.0.1",
		Api: api{
			Image:     postgrestImage,
			KongImage: kongImage,
		},
		Db: db{
			Image:    Pg15Image,
			Password: "postgres",
			RootKey:  "d4dc5b6d4a1d6a10b2c1e76112c994d65db7cec380572cc1839624d4be3fa275",
			Pooler: pooler{
				Image:         supavisorImage,
				TenantId:      "pooler-dev",
				EncryptionKey: "12345678901234567890123456789032",
				SecretKeyBase: "EAx3IQ/wRG1v47ZD4NE4/9RzBI8Jmil3x0yhcW4V2NHBP6c2iPIzwjofi2Ep4HIG",
			},
			Seed: seed{
				Enabled:      true,
				GlobPatterns: []string{"./seed.sql"},
			},
		},
		Realtime: realtime{
			Image:           realtimeImage,
			IpVersion:       AddressIPv4,
			MaxHeaderLength: 4096,
			TenantId:        "realtime-dev",
			EncryptionKey:   "supabaserealtime",
			SecretKeyBase:   "EAx3IQ/wRG1v47ZD4NE4/9RzBI8Jmil3x0yhcW4V2NHBP6c2iPIzwjofi2Ep4HIG",
		},
		Storage: storage{
			Image: storageImage,
			S3Credentials: storageS3Credentials{
				AccessKeyId:     "625729a08b95bf1b7ff351a663f3a23c",
				SecretAccessKey: "850181e4652dd023b7a98c58ae0d2d34bd487ee0cc3254aed6eda37307425907",
				Region:          "local",
			},
			ImageTransformation: imageTransformation{
				Enabled: true,
				Image:   imageProxyImage,
			},
		},
		Auth: auth{
			Image: gotrueImage,
			Email: email{
				Template: map[string]emailTemplate{
					"invite":       {},
					"confirmation": {},
					"recovery":     {},
					"magic_link":   {},
					"email_change": {},
				},
				Smtp: smtp{
					Host:       "inbucket",
					Port:       2500,
					AdminEmail: "admin@email.com",
				},
			},
			External: map[string]provider{
				"apple":         {},
				"azure":         {},
				"bitbucket":     {},
				"discord":       {},
				"facebook":      {},
				"github":        {},
				"gitlab":        {},
				"google":        {},
				"keycloak":      {},
				"linkedin":      {}, // TODO: remove this field in v2
				"linkedin_oidc": {},
				"notion":        {},
				"twitch":        {},
				"twitter":       {},
				"slack":         {}, // TODO: remove this field in v2
				"slack_oidc":    {},
				"spotify":       {},
				"workos":        {},
				"zoom":          {},
			},
			JwtSecret: defaultJwtSecret,
		},
		Inbucket: inbucket{
			Image: inbucketImage,
		},
		Studio: studio{
			Image:       studioImage,
			PgmetaImage: pgmetaImage,
		},
		Analytics: analytics{
			Image:       logflareImage,
			VectorImage: vectorImage,
			ApiKey:      "api-key",
			// Defaults to bigquery for backwards compatibility with existing config.toml
			Backend: LogflareBigQuery,
		},
		EdgeRuntime: edgeRuntime{
			Image: edgeRuntimeImage,
		},
	}}
	for _, apply := range editors {
		apply(&initial)
	}
	return initial
}

var (
	//go:embed templates/config.toml
	initConfigEmbed    string
	initConfigTemplate = template.Must(template.New("initConfig").Parse(initConfigEmbed))

	invalidProjectId = regexp.MustCompile("[^a-zA-Z0-9_.-]+")
	// envPattern       = regexp.MustCompile(`^env\((.*)\)$`)
)

func (fc FunctionConfig) Validate() error {
	for slug, fn := range fc {
		err := validate.Var(slug, "function_slug")
		if err != nil {
			return err
		}
		// Validate the function struct
		err = validate.Struct(fn)
		if err != nil {
			return err
		}
	}
	return nil
}

func (c *config) Eject(w io.Writer) error {
	// Defaults to current directory name as project id
	if len(c.ProjectId) == 0 {
		cwd, err := os.Getwd()
		if err != nil {
			return errors.Errorf("failed to get working directory: %w", err)
		}
		c.ProjectId = filepath.Base(cwd)
	}
	c.ProjectId = sanitizeProjectId(c.ProjectId)
	// TODO: templatize all fields eventually
	if err := initConfigTemplate.Option("missingkey=error").Execute(w, c); err != nil {
		return errors.Errorf("failed to initialise config: %w", err)
	}
	return nil
}

func printStructFields(v reflect.Value, prefix string) {
	t := v.Type()
	for i := 0; i < v.NumField(); i++ {
		field := t.Field(i)
		value := v.Field(i)

		// Check if the field is exported
		if field.PkgPath == "" {
			fmt.Printf("%sField: %s, Type: %v, Value: %v, Tags: %v\n", prefix, field.Name, field.Type, value.Interface(), field.Tag)
		} else {
			fmt.Printf("%sField: %s, Type: %v, Value: <unexported>, Tags: %v\n", prefix, field.Name, field.Type, field.Tag)
		}

		if field.Type.Kind() == reflect.Struct {
			printStructFields(value, prefix+"  ")
		}
	}
}

func (c *config) ValidateWithErrors() []validator.ValidationErrors {
	validate := validator.New(validator.WithRequiredStructEnabled())

	// Add this debug function
	validate.RegisterTagNameFunc(func(fld reflect.StructField) string {
		name := strings.SplitN(fld.Tag.Get("json"), ",", 2)[0]
		if name == "-" {
			return ""
		}
		return name
	})
	validate.RegisterValidation("project_id", projectIDValidator)
	validate.RegisterValidation("env_or_string", envOrString)
	validate.RegisterValidation("db_major_version", dbMajorVersionValidator)
	validate.RegisterValidation("bucket_name", bucketNameValidator)
	validate.RegisterValidation("file", fileExistsValidator)
	validate.RegisterValidation("hook_config", hookValidator)
	validate.RegisterValidation("third_party", thirdPartyValidator)

	// Initialize the translator
	en := en.New()
	uni := ut.New(en, en)
	translator, _ := uni.GetTranslator("en")

	// Register the custom error message for env_or_string
	validate.RegisterTranslation("env_or_string", translator, func(ut ut.Translator) error {
		return ut.Add("env_or_string", "{0} must be a non-empty string or refer to a set environment variable in the form env(SOMETHING).", true)
	}, func(ut ut.Translator, fe validator.FieldError) string {
		t, _ := ut.T("env_or_string", fe.Field())
		return t
	})
	// Add custom validation for the Experimental field
	validate.RegisterStructValidation(func(sl validator.StructLevel) {
		exp := sl.Current().Interface().(experimental)
		if exp.OrioleDBVersion != "" {
			if exp.S3Host == "" || exp.S3Region == "" || exp.S3AccessKey == "" || exp.S3SecretKey == "" {
				sl.ReportError(exp, "Experimental", "Experimental", "experimental_config", "")
			}
		}
	}, experimental{})

	if sanitized := sanitizeProjectId(c.ProjectId); sanitized != c.ProjectId {
		fmt.Fprintln(os.Stderr, "WARNING:", "project_id field in config is invalid. Auto-fixing to", sanitized)
		c.ProjectId = sanitized
	}
	switch c.Db.MajorVersion {
	case 13:
		c.Db.Image = pg13Image
	case 14:
		c.Db.Image = pg14Image
	case 15:
		if len(c.Experimental.OrioleDBVersion) > 0 {
			c.Db.Image = "supabase/postgres:orioledb-" + c.Experimental.OrioleDBVersion
		}
	}

	// Add this debug function
	validate.RegisterTagNameFunc(func(fld reflect.StructField) string {
		name := strings.SplitN(fld.Tag.Get("json"), ",", 2)[0]
		if name == "-" {
			return ""
		}
		return name
	})

	// Print struct fields
	fmt.Println("Config structure:")
	printStructFields(reflect.ValueOf(c.baseConfig), "")

	var errs []validator.ValidationErrors
	if err := validate.Struct(c.baseConfig); err != nil {
		if validationErrs, ok := err.(validator.ValidationErrors); ok {
			for _, err := range validationErrs {
				fmt.Printf("Validation error: Field: %s, Tag: %s, Type: %v, Value: %v\n",
					err.Namespace(), err.Tag(), err.Type(), err.Value())
			}
			errs = append(errs, validationErrs)
		}
	}

	return errs
}

func (c *config) Load(path string, fsys fs.FS) error {
	builder := NewPathBuilder(path)
	// Load default values
	var buf bytes.Buffer
	if err := initConfigTemplate.Option("missingkey=zero").Execute(&buf, c); err != nil {
		return errors.Errorf("failed to initialise config template: %w", err)
	}
	dec := toml.NewDecoder(&buf)
	if _, err := dec.Decode(c); err != nil {
		return errors.Errorf("failed to decode config template: %w", err)
	}
	if metadata, err := toml.DecodeFS(fsys, builder.ConfigPath, c); err != nil {
		cwd, osErr := os.Getwd()
		if osErr != nil {
			cwd = "current directory"
		}
		return errors.Errorf("cannot read config in %s: %w", cwd, err)
	} else if undecoded := metadata.Undecoded(); len(undecoded) > 0 {
		for _, key := range undecoded {
			if key[0] != "remotes" {
				fmt.Fprintf(os.Stderr, "Unknown config field: [%s]\n", key)
			}
		}
	}
	// Load secrets from .env file
	if err := loadDefaultEnv(); err != nil {
		return err
	}
	if err := viper.Unmarshal(c); err != nil {
		return errors.Errorf("failed to parse env to config: %w", err)
	}
	// Generate JWT tokens
	if len(c.Auth.AnonKey) == 0 {
		anonToken := CustomClaims{Role: "anon"}.NewToken()
		if signed, err := anonToken.SignedString([]byte(c.Auth.JwtSecret)); err != nil {
			return errors.Errorf("failed to generate anon key: %w", err)
		} else {
			c.Auth.AnonKey = signed
		}
	}
	if len(c.Auth.ServiceRoleKey) == 0 {
		anonToken := CustomClaims{Role: "service_role"}.NewToken()
		if signed, err := anonToken.SignedString([]byte(c.Auth.JwtSecret)); err != nil {
			return errors.Errorf("failed to generate service_role key: %w", err)
		} else {
			c.Auth.ServiceRoleKey = signed
		}
	}
	// TODO: move linked pooler connection string elsewhere
	if connString, err := fs.ReadFile(fsys, builder.PoolerUrlPath); err == nil && len(connString) > 0 {
		c.Db.Pooler.ConnectionString = string(connString)
	}
	// Update external api url
	apiUrl := url.URL{Host: net.JoinHostPort(c.Hostname,
		strconv.FormatUint(uint64(c.Api.Port), 10),
	)}
	if c.Api.Tls.Enabled {
		apiUrl.Scheme = "https"
	} else {
		apiUrl.Scheme = "http"
	}
	c.Api.ExternalUrl = apiUrl.String()
	// Update image versions
	if version, err := fs.ReadFile(fsys, builder.PostgresVersionPath); err == nil {
		if strings.HasPrefix(string(version), "15.") && semver.Compare(string(version[3:]), "1.0.55") >= 0 {
			c.Db.Image = replaceImageTag(Pg15Image, string(version))
		}
	}
	if c.Db.MajorVersion > 14 {
		if version, err := fs.ReadFile(fsys, builder.RestVersionPath); err == nil && len(version) > 0 {
			c.Api.Image = replaceImageTag(postgrestImage, string(version))
		}
		if version, err := fs.ReadFile(fsys, builder.StorageVersionPath); err == nil && len(version) > 0 {
			c.Storage.Image = replaceImageTag(storageImage, string(version))
		}
		if version, err := fs.ReadFile(fsys, builder.GotrueVersionPath); err == nil && len(version) > 0 {
			c.Auth.Image = replaceImageTag(gotrueImage, string(version))
		}
	}
	if version, err := fs.ReadFile(fsys, builder.PoolerVersionPath); err == nil && len(version) > 0 {
		c.Db.Pooler.Image = replaceImageTag(supavisorImage, string(version))
	}
	if version, err := fs.ReadFile(fsys, builder.RealtimeVersionPath); err == nil && len(version) > 0 {
		c.Realtime.Image = replaceImageTag(realtimeImage, string(version))
	}
	if version, err := fs.ReadFile(fsys, builder.StudioVersionPath); err == nil && len(version) > 0 {
		c.Studio.Image = replaceImageTag(studioImage, string(version))
	}
	if version, err := fs.ReadFile(fsys, builder.PgmetaVersionPath); err == nil && len(version) > 0 {
		c.Studio.PgmetaImage = replaceImageTag(pgmetaImage, string(version))
	}
	// Update fallback configs
	for name, bucket := range c.Storage.Buckets {
		if bucket.FileSizeLimit == 0 {
			bucket.FileSizeLimit = c.Storage.FileSizeLimit
		}
		c.Storage.Buckets[name] = bucket
	}
	for slug, function := range c.Functions {
		// TODO: support configuring alternative entrypoint path, such as index.js
		if len(function.Entrypoint) == 0 {
			function.Entrypoint = filepath.Join(builder.FunctionsDir, slug, "index.ts")
		} else if !filepath.IsAbs(function.Entrypoint) {
			// Append supabase/ because paths in configs are specified relative to config.toml
			function.Entrypoint = filepath.Join(builder.SupabaseDirPath, function.Entrypoint)
		}
		// Functions may not use import map so we don't set a default value
		if len(function.ImportMap) > 0 && !filepath.IsAbs(function.ImportMap) {
			function.ImportMap = filepath.Join(builder.SupabaseDirPath, function.ImportMap)
		}
		c.Functions[slug] = function
	}

	if err := c.Db.Seed.loadSeedPaths(builder.SupabaseDirPath, fsys); err != nil {
		return err
	}
	if err := c.baseConfig.Validate(fsys); err != nil {
		return err
	}
	c.Remotes = make(map[string]baseConfig, len(c.Overrides))
	for name, remote := range c.Overrides {
		base := c.baseConfig.Clone()
		// Encode a toml file with only config overrides
		var buf bytes.Buffer
		if err := toml.NewEncoder(&buf).Encode(remote); err != nil {
			return errors.Errorf("failed to encode map to TOML: %w", err)
		}
		// Decode overrides using base config as defaults
		if metadata, err := toml.NewDecoder(&buf).Decode(&base); err != nil {
			return errors.Errorf("failed to decode remote config: %w", err)
		} else if undecoded := metadata.Undecoded(); len(undecoded) > 0 {
			fmt.Fprintf(os.Stderr, "Unknown config fields: %+v\n", undecoded)
		}
		if err := base.Validate(fsys); err != nil {
			return err
		}
		c.Remotes[name] = base
	}
	return nil
}

func (c *baseConfig) Validate(fsys fs.FS) error {
	if c.ProjectId == "" {
		return errors.New("Missing required field in config: project_id")
	} else if sanitized := sanitizeProjectId(c.ProjectId); sanitized != c.ProjectId {
		fmt.Fprintln(os.Stderr, "WARNING:", "project_id field in config is invalid. Auto-fixing to", sanitized)
		c.ProjectId = sanitized
	}
	// Validate api config
	if c.Api.Enabled {
		if c.Api.Port == 0 {
			return errors.New("Missing required field in config: api.port")
		}
	}
	// Validate db config
	if c.Db.Port == 0 {
		return errors.New("Missing required field in config: db.port")
	}
	switch c.Db.MajorVersion {
	case 0:
		return errors.New("Missing required field in config: db.major_version")
	case 12:
		return errors.New("Postgres version 12.x is unsupported. To use the CLI, either start a new project or follow project migration steps here: https://supabase.com/docs/guides/database#migrating-between-projects.")
	case 13:
		c.Db.Image = pg13Image
	case 14:
		c.Db.Image = pg14Image
	case 15:
		if len(c.Experimental.OrioleDBVersion) > 0 {
			c.Db.Image = "supabase/postgres:orioledb-" + c.Experimental.OrioleDBVersion
			var err error
			if c.Experimental.S3Host, err = maybeLoadEnv(c.Experimental.S3Host); err != nil {
				return err
			}
			if c.Experimental.S3Region, err = maybeLoadEnv(c.Experimental.S3Region); err != nil {
				return err
			}
			if c.Experimental.S3AccessKey, err = maybeLoadEnv(c.Experimental.S3AccessKey); err != nil {
				return err
			}
			if c.Experimental.S3SecretKey, err = maybeLoadEnv(c.Experimental.S3SecretKey); err != nil {
				return err
			}
		}
	default:
		return errors.Errorf("Failed reading config: Invalid %s: %v.", "db.major_version", c.Db.MajorVersion)
	}
	// Validate pooler config
	if c.Db.Pooler.Enabled {
		allowed := []PoolMode{TransactionMode, SessionMode}
		if !sliceContains(allowed, c.Db.Pooler.PoolMode) {
			return errors.Errorf("Invalid config for db.pooler.pool_mode. Must be one of: %v", allowed)
		}
	}
	// Validate realtime config
	if c.Realtime.Enabled {
		allowed := []AddressFamily{AddressIPv6, AddressIPv4}
		if !sliceContains(allowed, c.Realtime.IpVersion) {
			return errors.Errorf("Invalid config for realtime.ip_version. Must be one of: %v", allowed)
		}
	}
	// Validate storage config
	for name := range c.Storage.Buckets {
		if err := ValidateBucketName(name); err != nil {
			return err
		}
	}
	// Validate studio config
	if c.Studio.Enabled {
		if c.Studio.Port == 0 {
			return errors.New("Missing required field in config: studio.port")
		}
		if parsed, err := url.Parse(c.Studio.ApiUrl); err != nil {
			return errors.Errorf("Invalid config for studio.api_url: %w", err)
		} else if parsed.Host == "" || parsed.Host == c.Hostname {
			c.Studio.ApiUrl = c.Api.ExternalUrl
		}
		c.Studio.OpenaiApiKey, _ = maybeLoadEnv(c.Studio.OpenaiApiKey)
	}
	// Validate smtp config
	if c.Inbucket.Enabled {
		if c.Inbucket.Port == 0 {
			return errors.New("Missing required field in config: inbucket.port")
		}
	}
	// Validate auth config
	if c.Auth.Enabled {
		if c.Auth.SiteUrl == "" {
			return errors.New("Missing required field in config: auth.site_url")
		}
		var err error
		if c.Auth.SiteUrl, err = maybeLoadEnv(c.Auth.SiteUrl); err != nil {
			return err
		}
		// Validate email config
		for name, tmpl := range c.Auth.Email.Template {
			if len(tmpl.ContentPath) > 0 {
				if _, err = fs.Stat(fsys, filepath.Clean(tmpl.ContentPath)); err != nil {
					return errors.Errorf("Invalid config for auth.email.%s.content_path: %s", name, tmpl.ContentPath)
				}
			}
		}
		if c.Auth.Email.Smtp.Pass, err = maybeLoadEnv(c.Auth.Email.Smtp.Pass); err != nil {
			return err
		}
		// Validate sms config
		if c.Auth.Sms.Twilio.Enabled {
			if len(c.Auth.Sms.Twilio.AccountSid) == 0 {
				return errors.New("Missing required field in config: auth.sms.twilio.account_sid")
			}
			if len(c.Auth.Sms.Twilio.MessageServiceSid) == 0 {
				return errors.New("Missing required field in config: auth.sms.twilio.message_service_sid")
			}
			if len(c.Auth.Sms.Twilio.AuthToken) == 0 {
				return errors.New("Missing required field in config: auth.sms.twilio.auth_token")
			}
			if c.Auth.Sms.Twilio.AuthToken, err = maybeLoadEnv(c.Auth.Sms.Twilio.AuthToken); err != nil {
				return err
			}
		}
		if c.Auth.Sms.TwilioVerify.Enabled {
			if len(c.Auth.Sms.TwilioVerify.AccountSid) == 0 {
				return errors.New("Missing required field in config: auth.sms.twilio_verify.account_sid")
			}
			if len(c.Auth.Sms.TwilioVerify.MessageServiceSid) == 0 {
				return errors.New("Missing required field in config: auth.sms.twilio_verify.message_service_sid")
			}
			if len(c.Auth.Sms.TwilioVerify.AuthToken) == 0 {
				return errors.New("Missing required field in config: auth.sms.twilio_verify.auth_token")
			}
			if c.Auth.Sms.TwilioVerify.AuthToken, err = maybeLoadEnv(c.Auth.Sms.TwilioVerify.AuthToken); err != nil {
				return err
			}
		}
		if c.Auth.Sms.Messagebird.Enabled {
			if len(c.Auth.Sms.Messagebird.Originator) == 0 {
				return errors.New("Missing required field in config: auth.sms.messagebird.originator")
			}
			if len(c.Auth.Sms.Messagebird.AccessKey) == 0 {
				return errors.New("Missing required field in config: auth.sms.messagebird.access_key")
			}
			if c.Auth.Sms.Messagebird.AccessKey, err = maybeLoadEnv(c.Auth.Sms.Messagebird.AccessKey); err != nil {
				return err
			}
		}
		if c.Auth.Sms.Textlocal.Enabled {
			if len(c.Auth.Sms.Textlocal.Sender) == 0 {
				return errors.New("Missing required field in config: auth.sms.textlocal.sender")
			}
			if len(c.Auth.Sms.Textlocal.ApiKey) == 0 {
				return errors.New("Missing required field in config: auth.sms.textlocal.api_key")
			}
			if c.Auth.Sms.Textlocal.ApiKey, err = maybeLoadEnv(c.Auth.Sms.Textlocal.ApiKey); err != nil {
				return err
			}
		}
		if c.Auth.Sms.Vonage.Enabled {
			if len(c.Auth.Sms.Vonage.From) == 0 {
				return errors.New("Missing required field in config: auth.sms.vonage.from")
			}
			if len(c.Auth.Sms.Vonage.ApiKey) == 0 {
				return errors.New("Missing required field in config: auth.sms.vonage.api_key")
			}
			if len(c.Auth.Sms.Vonage.ApiSecret) == 0 {
				return errors.New("Missing required field in config: auth.sms.vonage.api_secret")
			}
			if c.Auth.Sms.Vonage.ApiKey, err = maybeLoadEnv(c.Auth.Sms.Vonage.ApiKey); err != nil {
				return err
			}
			if c.Auth.Sms.Vonage.ApiSecret, err = maybeLoadEnv(c.Auth.Sms.Vonage.ApiSecret); err != nil {
				return err
			}
		}
		if err := c.Auth.Hook.MFAVerificationAttempt.HandleHook("mfa_verification_attempt"); err != nil {
			return err
		}
		if err := c.Auth.Hook.PasswordVerificationAttempt.HandleHook("password_verification_attempt"); err != nil {
			return err
		}
		if err := c.Auth.Hook.CustomAccessToken.HandleHook("custom_access_token"); err != nil {
			return err
		}
		if err := c.Auth.Hook.SendSMS.HandleHook("send_sms"); err != nil {
			return err
		}
		if err := c.Auth.Hook.SendEmail.HandleHook("send_email"); err != nil {
			return err
		}
		// Validate oauth config
		for ext, provider := range c.Auth.External {
			if !provider.Enabled {
				continue
			}
			if provider.ClientId == "" {
				return errors.Errorf("Missing required field in config: auth.external.%s.client_id", ext)
			}
			if !sliceContains([]string{"apple", "google"}, ext) && provider.Secret == "" {
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
			c.Auth.External[ext] = provider
		}
	}
	// Validate Third-Party Auth config
	if err := c.Auth.ThirdParty.validate(); err != nil {
		return err
	}
	// Validate functions config
	if c.EdgeRuntime.Enabled {
		allowed := []RequestPolicy{PolicyPerWorker, PolicyOneshot}
		if !sliceContains(allowed, c.EdgeRuntime.Policy) {
			return errors.Errorf("Invalid config for edge_runtime.policy. Must be one of: %v", allowed)
		}
	}
	for name := range c.Functions {
		if err := ValidateFunctionSlug(name); err != nil {
			return err
		}
	}
	// Validate logflare config
	if c.Analytics.Enabled {
		switch c.Analytics.Backend {
		case LogflareBigQuery:
			if len(c.Analytics.GcpProjectId) == 0 {
				return errors.New("Missing required field in config: analytics.gcp_project_id")
			}
			if len(c.Analytics.GcpProjectNumber) == 0 {
				return errors.New("Missing required field in config: analytics.gcp_project_number")
			}
			if len(c.Analytics.GcpJwtPath) == 0 {
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

func truncateText(text string, maxLen int) string {
	if len(text) > maxLen {
		return text[:maxLen]
	}
	return text
}

const maxProjectIdLength = 40

func sanitizeProjectId(src string) string {
	// A valid project ID must only contain alphanumeric and special characters _.-
	sanitized := invalidProjectId.ReplaceAllString(src, "_")
	// It must also start with an alphanumeric character
	sanitized = strings.TrimLeft(sanitized, "_.-")
	// Truncate sanitized ID to 40 characters since docker hostnames cannot exceed
	// 63 characters, and we need to save space for padding supabase_*_edge_runtime.
	return truncateText(sanitized, maxProjectIdLength)
}

func loadDefaultEnv() error {
	env := viper.GetString("ENV")
	if env == "" {
		env = "development"
	}
	filenames := []string{".env." + env + ".local"}
	if env != "test" {
		filenames = append(filenames, ".env.local")
	}
	filenames = append(filenames, ".env."+env, ".env")
	for _, path := range filenames {
		if err := loadEnvIfExists(path); err != nil {
			return err
		}
	}
	return nil
}

func loadEnvIfExists(path string) error {
	if err := godotenv.Load(path); err != nil && !errors.Is(err, os.ErrNotExist) {
		return errors.Errorf("failed to load %s: %w", ".env", err)
	}
	return nil
}

// Match the glob patterns from the config to get a deduplicated
// array of all migrations files to apply in the declared order.
func (c *seed) loadSeedPaths(basePath string, fsys fs.FS) error {
	if !c.Enabled {
		return nil
	}
	if c.SqlPaths != nil {
		// Reuse already allocated array
		c.SqlPaths = c.SqlPaths[:0]
	}
	set := make(map[string]struct{})
	for _, pattern := range c.GlobPatterns {
		// Glob expects / as path separator on windows
		pattern = filepath.ToSlash(pattern)
		if !filepath.IsAbs(pattern) {
			pattern = path.Join(basePath, pattern)
		}
		matches, err := fs.Glob(fsys, pattern)
		if err != nil {
			return errors.Errorf("failed to apply glob pattern: %w", err)
		}
		if len(matches) == 0 {
			fmt.Fprintln(os.Stderr, "No seed files matched pattern:", pattern)
		}
		sort.Strings(matches)
		// Remove duplicates
		for _, item := range matches {
			if _, exists := set[item]; !exists {
				set[item] = struct{}{}
				c.SqlPaths = append(c.SqlPaths, item)
			}
		}
	}
	return nil
}

func (h *hookConfig) HandleHook(hookType string) error {
	// If not enabled do nothing
	if !h.Enabled {
		return nil
	}
	if h.URI == "" {
		return errors.Errorf("missing required field in config: auth.hook.%s.uri", hookType)
	}
	if err := validateHookURI(h.URI, hookType); err != nil {
		return err
	}
	var err error
	if h.Secrets, err = maybeLoadEnv(h.Secrets); err != nil {
		return errors.Errorf("missing required field in config: auth.hook.%s.secrets", hookType)
	}
	return nil
}

// TODO: use field tag validator instead
var funcSlugPattern = regexp.MustCompile(`^[A-Za-z][A-Za-z0-9_-]*$`)

func ValidateFunctionSlug(slug string) error {
	if !funcSlugPattern.MatchString(slug) {
		return errors.Errorf(`Invalid Function name: %s. Must start with at least one letter, and only include alphanumeric characters, underscores, and hyphens. (%s)`, slug, funcSlugPattern.String())
	}
	return nil
}

// Ref: https://github.com/supabase/storage/blob/master/src/storage/limits.ts#L59
var bucketNamePattern = regexp.MustCompile(`^(\w|!|-|\.|\*|'|\(|\)| |&|\$|@|=|;|:|\+|,|\?)*$`)

func ValidateBucketName(name string) error {
	if !bucketNamePattern.MatchString(name) {
		return errors.Errorf("Invalid Bucket name: %s. Only lowercase letters, numbers, dots, hyphens, and spaces are allowed. (%s)", name, bucketNamePattern.String())
	}
	return nil
}

func (f *tpaFirebase) issuerURL() string {
	return fmt.Sprintf("https://securetoken.google.com/%s", f.ProjectID)
}

func (f *tpaFirebase) validate() error {
	if f.ProjectID == "" {
		return errors.New("Invalid config: auth.third_party.firebase is enabled but without a project_id.")
	}

	return nil
}

func (a *tpaAuth0) issuerURL() string {
	if a.TenantRegion != "" {
		return fmt.Sprintf("https://%s.%s.auth0.com", a.Tenant, a.TenantRegion)
	}

	return fmt.Sprintf("https://%s.auth0.com", a.Tenant)
}

func (a *tpaAuth0) validate() error {
	if a.Tenant == "" {
		return errors.New("Invalid config: auth.third_party.auth0 is enabled but without a tenant.")
	}

	return nil
}

func (c *tpaCognito) issuerURL() string {
	return fmt.Sprintf("https://cognito-idp.%s.amazonaws.com/%s", c.UserPoolRegion, c.UserPoolID)
}

func (c *tpaCognito) validate() error {
	if c.UserPoolID == "" {
		return errors.New("Invalid config: auth.third_party.cognito is enabled but without a user_pool_id.")
	}
	var err error
	if c.UserPoolID, err = maybeLoadEnv(c.UserPoolID); err != nil {
		return err
	}

	if c.UserPoolRegion == "" {
		return errors.New("Invalid config: auth.third_party.cognito is enabled but without a user_pool_region.")
	}
	if c.UserPoolRegion, err = maybeLoadEnv(c.UserPoolRegion); err != nil {
		return err
	}

	return nil
}

func (tpa *thirdParty) validate() error {
	enabled := 0

	if tpa.Firebase.Enabled {
		enabled += 1

		if err := tpa.Firebase.validate(); err != nil {
			return err
		}
	}

	if tpa.Auth0.Enabled {
		enabled += 1

		if err := tpa.Auth0.validate(); err != nil {
			return err
		}
	}

	if tpa.Cognito.Enabled {
		enabled += 1

		if err := tpa.Cognito.validate(); err != nil {
			return err
		}
	}

	if enabled > 1 {
		return errors.New("Invalid config: Only one third_party provider allowed to be enabled at a time.")
	}

	return nil
}

func (tpa *thirdParty) IssuerURL() string {
	if tpa.Firebase.Enabled {
		return tpa.Firebase.issuerURL()
	}

	if tpa.Auth0.Enabled {
		return tpa.Auth0.issuerURL()
	}

	if tpa.Cognito.Enabled {
		return tpa.Cognito.issuerURL()
	}

	return ""
}

// ResolveJWKS creates the JWKS from the JWT secret and Third-Party Auth
// configs by resolving the JWKS via the OIDC discovery URL.
// It always returns a JWKS string, except when there's an error fetching.
func (a *auth) ResolveJWKS(ctx context.Context) (string, error) {
	var jwks struct {
		Keys []json.RawMessage `json:"keys"`
	}

	issuerURL := a.ThirdParty.IssuerURL()
	if issuerURL != "" {
		discoveryURL := issuerURL + "/.well-known/openid-configuration"

		t := &http.Client{Timeout: 10 * time.Second}
		client := fetcher.NewFetcher(
			discoveryURL,
			fetcher.WithHTTPClient(t),
			fetcher.WithExpectedStatus(http.StatusOK),
		)

		resp, err := client.Send(ctx, http.MethodGet, "", nil)
		if err != nil {
			return "", err
		}

		type oidcConfiguration struct {
			JWKSURI string `json:"jwks_uri"`
		}

		oidcConfig, err := fetcher.ParseJSON[oidcConfiguration](resp.Body)
		if err != nil {
			return "", err
		}

		if oidcConfig.JWKSURI == "" {
			return "", fmt.Errorf("auth.third_party: OIDC configuration at URL %q does not expose a jwks_uri property", discoveryURL)
		}

		client = fetcher.NewFetcher(
			oidcConfig.JWKSURI,
			fetcher.WithHTTPClient(t),
			fetcher.WithExpectedStatus(http.StatusOK),
		)

		resp, err = client.Send(ctx, http.MethodGet, "", nil)
		if err != nil {
			return "", err
		}

		type remoteJWKS struct {
			Keys []json.RawMessage `json:"keys"`
		}

		rJWKS, err := fetcher.ParseJSON[remoteJWKS](resp.Body)
		if err != nil {
			return "", err
		}

		if len(rJWKS.Keys) == 0 {
			return "", fmt.Errorf("auth.third_party: JWKS at URL %q as discovered from %q does not contain any JWK keys", oidcConfig.JWKSURI, discoveryURL)
		}

		jwks.Keys = rJWKS.Keys
	}

	var secretJWK struct {
		KeyType      string `json:"kty"`
		KeyBase64URL string `json:"k"`
	}

	secretJWK.KeyType = "oct"
	secretJWK.KeyBase64URL = base64.RawURLEncoding.EncodeToString([]byte(a.JwtSecret))

	secretJWKEncoded, err := json.Marshal(&secretJWK)
	if err != nil {
		return "", errors.Errorf("failed to marshal secret jwk: %w", err)
	}

	jwks.Keys = append(jwks.Keys, json.RawMessage(secretJWKEncoded))

	jwksEncoded, err := json.Marshal(jwks)
	if err != nil {
		return "", errors.Errorf("failed to marshal jwks keys: %w", err)
	}

	return string(jwksEncoded), nil
}
