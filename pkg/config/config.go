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
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"text/template"
	"time"

	"github.com/BurntSushi/toml"
	"github.com/docker/go-units"
	"github.com/go-errors/errors"
	"github.com/golang-jwt/jwt/v5"
	"github.com/invopop/jsonschema"
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
	config struct {
		ProjectId    string         `toml:"project_id" json:"project_id" jsonschema:"required,description=A string used to distinguish different Supabase projects on the same host. Defaults to the working directory name when running \u0060supabase init\u0060."`
		Hostname     string         `toml:"-" json:"-" jsonschema:"default=127.0.0.1"`
		Api          api            `toml:"api" json:"api" jsonschema:"description=Configuration for the API service."`
		Db           db             `toml:"db" json:"db" mapstructure:"db" jsonschema:"description=Configuration for the database service."`
		Realtime     realtime       `toml:"realtime" json:"realtime" jsonschema:"description=Configuration for the Realtime service."`
		Studio       studio         `toml:"studio" json:"studio" jsonschema:"description=Configuration for the Studio dashboard."`
		Inbucket     inbucket       `toml:"inbucket" json:"inbucket" jsonschema:"description=Configuration for the email testing server."`
		Storage      storage        `toml:"storage" json:"storage" jsonschema:"description=Configuration for the Storage service."`
		Auth         auth           `toml:"auth" json:"auth" mapstructure:"auth" jsonschema:"description=Configuration for the Auth service."`
		EdgeRuntime  edgeRuntime    `toml:"edge_runtime" json:"edge_runtime" jsonschema:"description=Configuration for Edge Functions."`
		Functions    FunctionConfig `toml:"functions" json:"functions" jsonschema:"description=Configuration for individual functions."`
		Analytics    analytics      `toml:"analytics" json:"analytics" jsonschema:"description=Configuration for the Analytics service."`
		Experimental experimental   `toml:"experimental" json:"experimental" mapstructure:"-" jsonschema:"description=Experimental features configuration."`
	}

	api struct {
		Enabled         bool     `toml:"enabled" json:"enabled" jsonschema:"description=Enable the local PostgREST service.,default=true"`
		Image           string   `toml:"-" json:"-" jsonschema:"default=postgrest/postgrest:v12.2.0"`
		KongImage       string   `toml:"-" json:"-" jsonschema:"default=library/kong:2.8.1"`
		Port            uint16   `toml:"port" json:"port" jsonschema:"description=Port to use for the API URL.,default=54321"`
		Schemas         []string `toml:"schemas" json:"schemas" jsonschema:"description=Schemas to expose in your API. Tables, views and functions in this schema will get API endpoints. \u0060public\u0060 and \u0060storage\u0060 are always included."`
		ExtraSearchPath []string `toml:"extra_search_path" json:"extra_search_path" jsonschema:"description=Extra schemas to add to the search_path of every request. public is always included."`
		MaxRows         uint     `toml:"max_rows" json:"max_rows" jsonschema:"description=The maximum number of rows returned from a view, table, or stored procedure. Limits payload size for accidental or malicious requests.,default=1000"`
		Tls             tlsKong  `toml:"tls" json:"tls"`
		ExternalUrl     string   `toml:"external_url" json:"external_url"`
	}

	tlsKong struct {
		Enabled bool `toml:"enabled" json:"enabled"`
	}

	db struct {
		Image        string `toml:"-" json:"-" jsonschema:"default=supabase/postgres:15.1.1.78"`
		Port         uint16 `toml:"port" json:"port" jsonschema:"description=Port to use for the local database URL.,default=54322"`
		ShadowPort   uint16 `toml:"shadow_port" json:"shadow_port" jsonschema:"description=Port to use for the local shadow database.,default=54320"`
		MajorVersion uint   `toml:"major_version" json:"major_version" jsonschema:"description=The database major version to use. This has to be the same as your remote database's. Run \u0060SHOW server_version;\u0060 on the remote database to check.,default=15"`
		Password     string `toml:"-" json:"-" jsonschema:"default=postgres"`
		RootKey      string `toml:"-" json:"-" mapstructure:"root_key" jsonschema:"default=d4dc5b6d4a1d6a10b2c1e76112c994d65db7cec380572cc1839624d4be3fa275"`
		Pooler       pooler `toml:"pooler" json:"pooler"`
		Seed         seed   `toml:"seed" json:"seed"`
	}

	seed struct {
		Enabled bool `toml:"enabled" json:"enabled"`
	}

	pooler struct {
		Enabled          bool     `toml:"enabled" json:"enabled" jsonschema:"description=Enable the local PgBouncer service.,default=true"`
		Image            string   `toml:"-" json:"-" jsonschema:"default=supabase/supavisor:1.1.56"`
		Port             uint16   `toml:"port" json:"port" jsonschema:"description=Port to use for the local connection pooler.,default=54323"`
		PoolMode         PoolMode `toml:"pool_mode" json:"pool_mode" jsonschema:"description=Specifies when a server connection can be reused by other clients. Configure one of the supported pooler modes: \u0060transaction\u0060, \u0060session\u0060.,default=transaction"`
		DefaultPoolSize  uint     `toml:"default_pool_size" json:"default_pool_size" jsonschema:"description=How many server connections to allow per user/database pair.,default=50"`
		MaxClientConn    uint     `toml:"max_client_conn" json:"max_client_conn" jsonschema:"description=Maximum number of client connections allowed.,default=100"`
		ConnectionString string   `toml:"-" json:"-"`
		TenantId         string   `toml:"-" json:"-" jsonschema:"default=pooler-dev"`
		EncryptionKey    string   `toml:"-" json:"-" jsonschema:"default=12345678901234567890123456789032"`
		SecretKeyBase    string   `toml:"-" json:"-" jsonschema:"default=EAx3IQ/wRG1v47ZD4NE4/9RzBI8Jmil3x0yhcW4V2NHBP6c2iPIzwjofi2Ep4HIG"`
	}

	realtime struct {
		Enabled         bool          `toml:"enabled" json:"enabled" jsonschema:"description=Enable the local Realtime service.,default=true"`
		Image           string        `toml:"-" json:"-" jsonschema:"default=supabase/realtime:v2.30.34"`
		IpVersion       AddressFamily `toml:"ip_version" json:"ip_version" jsonschema:"description=Bind realtime via either IPv4 or IPv6. (default: IPv6),default=IPv4"`
		MaxHeaderLength uint          `toml:"max_header_length" json:"max_header_length" jsonschema:"default=4096"`
		TenantId        string        `toml:"-" json:"-" jsonschema:"default=realtime-dev"`
		EncryptionKey   string        `toml:"-" json:"-" jsonschema:"default=supabaserealtime"`
		SecretKeyBase   string        `toml:"-" json:"-" jsonschema:"default=EAx3IQ/wRG1v47ZD4NE4/9RzBI8Jmil3x0yhcW4V2NHBP6c2iPIzwjofi2Ep4HIG"`
	}

	studio struct {
		Enabled      bool   `toml:"enabled" json:"enabled" jsonschema:"description=Enable the local Supabase Studio dashboard.,default=true"`
		Image        string `toml:"-" json:"-" jsonschema:"default=supabase/studio:20240729-ce42139"`
		Port         uint16 `toml:"port" json:"port" jsonschema:"description=Port to use for Supabase Studio.,default=54324"`
		ApiUrl       string `toml:"api_url" json:"api_url" jsonschema:"description=External URL of the API server that frontend connects to."`
		OpenaiApiKey string `toml:"openai_api_key" json:"openai_api_key"`
		PgmetaImage  string `toml:"-" json:"-" jsonschema:"default=supabase/postgres-meta:v0.83.2"`
	}

	inbucket struct {
		Enabled  bool   `toml:"enabled" json:"enabled" jsonschema:"description=Enable the local InBucket service.,default=true"`
		Image    string `toml:"-" json:"-" jsonschema:"default=inbucket/inbucket:3.0.3"`
		Port     uint16 `toml:"port" json:"port" jsonschema:"description=Port to use for the email testing server web interface.,default=2501"`
		SmtpPort uint16 `toml:"smtp_port" json:"smtp_port" jsonschema:"description=Port to use for the email testing server SMTP port.,default=2500"`
		Pop3Port uint16 `toml:"pop3_port" json:"pop3_port" jsonschema:"description=Port to use for the email testing server POP3 port.,default=1100"`
	}

	storage struct {
		Enabled             bool                 `toml:"enabled" json:"enabled" jsonschema:"description=Enable the local Storage service.,default=true"`
		Image               string               `toml:"-" json:"-" jsonschema:"default=supabase/storage-api:v1.10.1"`
		FileSizeLimit       sizeInBytes          `toml:"file_size_limit" json:"file_size_limit" jsonschema:"description=The maximum file size allowed (e.g. \u00605MB\u0060, \u0060500KB\u0060)."`
		S3Credentials       storageS3Credentials `toml:"-" json:"-"`
		ImageTransformation imageTransformation  `toml:"image_transformation" json:"image_transformation"`
		Buckets             BucketConfig         `toml:"buckets" json:"buckets"`
	}

	BucketConfig map[string]bucket

	bucket struct {
		Public           *bool       `toml:"public" json:"public"`
		FileSizeLimit    sizeInBytes `toml:"file_size_limit" json:"file_size_limit"`
		AllowedMimeTypes []string    `toml:"allowed_mime_types" json:"allowed_mime_types"`
		ObjectsPath      string      `toml:"objects_path" json:"objects_path"`
	}

	imageTransformation struct {
		Enabled bool   `toml:"enabled" json:"enabled" jsonschema:"default=true"`
		Image   string `toml:"-" json:"-" jsonschema:"default=imageProxyImage"`
	}

	storageS3Credentials struct {
		AccessKeyId     string `toml:"-" json:"-" jsonschema:"default=625729a08b95bf1b7ff351a663f3a23c"`
		SecretAccessKey string `toml:"-" json:"-" jsonschema:"default=850181e4652dd023b7a98c58ae0d2d34bd487ee0cc3254aed6eda37307425907"`
		Region          string `toml:"-" json:"-" jsonschema:"default=local"`
	}

	auth struct {
		Enabled                bool     `toml:"enabled" json:"enabled" jsonschema:"description=Enable the local GoTrue service.,default=true"`
		Image                  string   `toml:"-" json:"-" jsonschema:"default=supabase/gotrue:v2.158.1"`
		SiteUrl                string   `toml:"site_url" json:"site_url" jsonschema:"description=The base URL of your website. Used as an allow-list for redirects and for constructing URLs used in emails."`
		AdditionalRedirectUrls []string `toml:"additional_redirect_urls" json:"additional_redirect_urls" jsonschema:"description=A list of _exact_ URLs that auth providers are permitted to redirect to post authentication."`

		JwtExpiry                  uint `toml:"jwt_expiry" json:"jwt_expiry" jsonschema:"description=How long tokens are valid for, in seconds. Defaults to 3600 (1 hour), maximum 604,800 seconds (one week).,default=3600"`
		EnableRefreshTokenRotation bool `toml:"enable_refresh_token_rotation" json:"enable_refresh_token_rotation" jsonschema:"description=If disabled, the refresh token will never expire.,default=false"`
		RefreshTokenReuseInterval  uint `toml:"refresh_token_reuse_interval" json:"refresh_token_reuse_interval" jsonschema:"description=Allows refresh tokens to be reused after expiry, up to the specified interval in seconds. Requires enable_refresh_token_rotation = true.,default=0"`
		EnableManualLinking        bool `toml:"enable_manual_linking" json:"enable_manual_linking" jsonschema:"default=false"`

		Hook     hook     `toml:"hook" json:"hook"`
		MFA      mfa      `toml:"mfa" json:"mfa"`
		Sessions sessions `toml:"sessions" json:"sessions"`

		EnableSignup           bool                `toml:"enable_signup" json:"enable_signup" jsonschema:"description=Allow/disallow new user signups to your project.,default=true"`
		EnableAnonymousSignIns bool                `toml:"enable_anonymous_sign_ins" json:"enable_anonymous_sign_ins" jsonschema:"description=Allow/disallow anonymous sign-ins to your project.,default=true"`
		Email                  email               `toml:"email" json:"email"`
		Sms                    sms                 `toml:"sms" json:"sms"`
		External               map[string]provider `json:"external"`

		JwtSecret      string `toml:"-" json:"-" mapstructure:"jwt_secret" jsonschema:"default=super-secret-jwt-token-with-at-least-32-characters-long"`
		AnonKey        string `toml:"-" json:"-" mapstructure:"anon_key"`
		ServiceRoleKey string `toml:"-" json:"-" mapstructure:"service_role_key"`

		ThirdParty thirdParty `toml:"third_party" json:"third_party"`
	}

	thirdParty struct {
		Firebase tpaFirebase `toml:"firebase" json:"firebase"`
		Auth0    tpaAuth0    `toml:"auth0" json:"auth0"`
		Cognito  tpaCognito  `toml:"aws_cognito" json:"aws_cognito"`
	}

	tpaFirebase struct {
		Enabled   bool   `toml:"enabled" json:"enabled"`
		ProjectID string `toml:"project_id" json:"project_id"`
	}

	tpaAuth0 struct {
		Enabled      bool   `toml:"enabled" json:"enabled"`
		Tenant       string `toml:"tenant" json:"tenant"`
		TenantRegion string `toml:"tenant_region" json:"tenant_region"`
	}

	tpaCognito struct {
		Enabled        bool   `toml:"enabled" json:"enabled"`
		UserPoolID     string `toml:"user_pool_id" json:"user_pool_id"`
		UserPoolRegion string `toml:"user_pool_region" json:"user_pool_region"`
	}

	email struct {
		EnableSignup         bool                     `toml:"enable_signup" json:"enable_signup" jsonschema:"description=Allow/disallow new user signups via email to your project.,default=true"`
		DoubleConfirmChanges bool                     `toml:"double_confirm_changes" json:"double_confirm_changes" jsonschema:"description=If enabled, a user will be required to confirm any email change on both the old, and new email addresses. If disabled, only the new email is required to confirm.,default=true"`
		EnableConfirmations  bool                     `toml:"enable_confirmations" json:"enable_confirmations" jsonschema:"description=If enabled, users need to confirm their email address before signing in.,default=true"`
		SecurePasswordChange bool                     `toml:"secure_password_change" json:"secure_password_change" jsonschema:"description=If enabled, users need to confirm their email address before changing their password.,default=true"`
		Template             map[string]emailTemplate `toml:"template" json:"template"`
		Smtp                 smtp                     `toml:"smtp" json:"smtp"`
		MaxFrequency         time.Duration            `toml:"max_frequency" json:"max_frequency"`
	}

	smtp struct {
		Host       string `toml:"host" json:"host" jsonschema:"description=Hostname or IP address of the SMTP server.,default=inbucket"`
		Port       uint16 `toml:"port" json:"port" jsonschema:"description=Port number of the SMTP server.,default=2500"`
		User       string `toml:"user" json:"user" jsonschema:"description=Username for authenticating with the SMTP server."`
		Pass       string `toml:"pass" json:"pass" jsonschema:"description=Password for authenticating with the SMTP server."`
		AdminEmail string `toml:"admin_email" json:"admin_email" jsonschema:"description=Email address of the administrator.,default=admin@email.com"`
		SenderName string `toml:"sender_name" json:"sender_name" jsonschema:"description=Name used as the sender for emails sent from the application."`
	}

	emailTemplate struct {
		Subject     string `toml:"subject" json:"subject"`
		ContentPath string `toml:"content_path" json:"content_path"`
	}

	sms struct {
		EnableSignup        bool              `toml:"enable_signup" json:"enable_signup" jsonschema:"description=Allow/disallow new user signups via SMS to your project.,default=true"`
		EnableConfirmations bool              `toml:"enable_confirmations" json:"enable_confirmations" jsonschema:"description=If enabled, users need to confirm their phone number before signing in.,default=true"`
		Template            string            `toml:"template" json:"template" jsonschema:"description=The template to use for SMS messages."`
		Twilio              twilioConfig      `toml:"twilio" json:"twilio" mapstructure:"twilio"`
		TwilioVerify        twilioConfig      `toml:"twilio_verify" json:"twilio_verify" mapstructure:"twilio_verify"`
		Messagebird         messagebirdConfig `toml:"messagebird" json:"messagebird" mapstructure:"messagebird"`
		Textlocal           textlocalConfig   `toml:"textlocal" json:"textlocal" mapstructure:"textlocal"`
		Vonage              vonageConfig      `toml:"vonage" json:"vonage" mapstructure:"vonage"`
		TestOTP             map[string]string `toml:"test_otp" json:"test_otp" jsonschema:"description=Test OTP codes for development."`
		MaxFrequency        time.Duration     `toml:"max_frequency" json:"max_frequency" jsonschema:"description=The maximum frequency of SMS messages that can be sent."`
	}

	hook struct {
		MFAVerificationAttempt      hookConfig `toml:"mfa_verification_attempt" json:"mfa_verification_attempt"`
		PasswordVerificationAttempt hookConfig `toml:"password_verification_attempt" json:"password_verification_attempt"`
		CustomAccessToken           hookConfig `toml:"custom_access_token" json:"custom_access_token"`
		SendSMS                     hookConfig `toml:"send_sms" json:"send_sms"`
		SendEmail                   hookConfig `toml:"send_email" json:"send_email"`
	}
	factorTypeConfiguration struct {
		EnrollEnabled bool `toml:"enroll_enabled" json:"enroll_enabled"`
		VerifyEnabled bool `toml:"verify_enabled" json:"verify_enabled"`
	}

	phoneFactorTypeConfiguration struct {
		factorTypeConfiguration
		OtpLength    uint          `toml:"otp_length" json:"otp_length"`
		Template     string        `toml:"template" json:"template"`
		MaxFrequency time.Duration `toml:"max_frequency" json:"max_frequency"`
	}

	mfa struct {
		TOTP               factorTypeConfiguration      `toml:"totp" json:"totp"`
		Phone              phoneFactorTypeConfiguration `toml:"phone" json:"phone"`
		MaxEnrolledFactors uint                         `toml:"max_enrolled_factors" json:"max_enrolled_factors"`
	}

	hookConfig struct {
		Enabled bool   `toml:"enabled" json:"enabled" jsonschema:"description=Enable the local hook service."`
		URI     string `toml:"uri" json:"uri" jsonschema:"description=The URL of the hook service."`
		Secrets string `toml:"secrets" json:"secrets" jsonschema:"description=The secrets for the hook service."`
	}

	sessions struct {
		Timebox           time.Duration `toml:"timebox" json:"timebox" jsonschema:"description=The maximum duration of a session."`
		InactivityTimeout time.Duration `toml:"inactivity_timeout" json:"inactivity_timeout" jsonschema:"description=The maximum duration of inactivity before a session is terminated."`
	}

	twilioConfig struct {
		Enabled           bool   `toml:"enabled" json:"enabled" jsonschema:"description=Enable Twilio for sending SMS messages."`
		AccountSid        string `toml:"account_sid" json:"account_sid" jsonschema:"description=The Twilio account SID."`
		MessageServiceSid string `toml:"message_service_sid" json:"message_service_sid" jsonschema:"description=The Twilio message service SID."`
		AuthToken         string `toml:"-" json:"-" mapstructure:"auth_token" jsonschema:"description=The Twilio auth token."`
	}

	messagebirdConfig struct {
		Enabled    bool   `toml:"enabled" json:"enabled" jsonschema:"description=Enable MessageBird for sending SMS messages."`
		Originator string `toml:"originator" json:"originator" jsonschema:"description=The MessageBird originator."`
		AccessKey  string `toml:"-" json:"-" mapstructure:"access_key" jsonschema:"description=The MessageBird access key."`
	}

	textlocalConfig struct {
		Enabled bool   `toml:"enabled" json:"enabled" jsonschema:"description=Enable Textlocal for sending SMS messages."`
		Sender  string `toml:"sender" json:"sender" jsonschema:"description=The Textlocal sender."`
		ApiKey  string `toml:"-" json:"-" mapstructure:"api_key" jsonschema:"description=The Textlocal API key."`
	}

	vonageConfig struct {
		Enabled   bool   `toml:"enabled" json:"enabled" jsonschema:"description=Enable Vonage for sending SMS messages."`
		From      string `toml:"from" json:"from" jsonschema:"description=The Vonage sender."`
		ApiKey    string `toml:"-" json:"-" mapstructure:"api_key" jsonschema:"description=The Vonage API key."`
		ApiSecret string `toml:"-" json:"-" mapstructure:"api_secret" jsonschema:"description=The Vonage API secret."`
	}

	provider struct {
		Enabled        bool   `toml:"enabled" json:"enabled" jsonschema:"description=Enable the provider for authentication."`
		ClientId       string `toml:"client_id" json:"client_id" jsonschema:"description=The provider client ID."`
		Secret         string `toml:"secret" json:"secret" jsonschema:"description=The provider secret."`
		Url            string `toml:"url" json:"url" jsonschema:"description=The provider URL."`
		RedirectUri    string `toml:"redirect_uri" json:"redirect_uri" jsonschema:"description=The provider redirect URI."`
		SkipNonceCheck bool   `toml:"skip_nonce_check" json:"skip_nonce_check" jsonschema:"description=Skip nonce check for the provider."`
	}

	edgeRuntime struct {
		Enabled       bool          `toml:"enabled" json:"enabled" jsonschema:"description=Enable the local Edge Functions service.,default=true"`
		Image         string        `toml:"-" json:"-" jsonschema:"default=supabase/edge-runtime:v1.58.3"`
		Policy        RequestPolicy `toml:"policy" json:"policy" jsonschema:"description=Configure one of the supported policies: \u0060per_worker\u0060, \u0060oneshot\u0060.,default=per_worker"`
		InspectorPort uint16        `toml:"inspector_port" json:"inspector_port" jsonschema:"default=54325"`
	}

	FunctionConfig map[string]function

	function struct {
		Enabled    *bool  `toml:"enabled" json:"enabled" jsonschema:"description=Controls whether a function is deployed or served. When set to false, the function will be skipped during deployment and won't be served locally."`
		VerifyJWT  *bool  `toml:"verify_jwt" json:"verifyJWT" jsonschema:"description=By default, when you deploy your Edge Functions or serve them locally, it will reject requests without a valid JWT in the Authorization header. Setting this configuration changes the default behavior."`
		ImportMap  string `toml:"import_map" json:"importMapPath,omitempty" jsonschema:"description=Specify the Deno import map file to use for the Function."`
		Entrypoint string `json:"-"`
	}

	analytics struct {
		Enabled          bool            `toml:"enabled" json:"enabled" jsonschema:"description=Enable the local Logflare service.,default=true"`
		Image            string          `toml:"-" json:"-" jsonschema:"default=supabase/logflare:1.4.0"`
		VectorImage      string          `toml:"-" json:"-" jsonschema:"default=timberio/vector:0.28.1-alpine"`
		Port             uint16          `toml:"port" json:"port" jsonschema:"description=Port to the local Logflare service.,default=54326"`
		Backend          LogflareBackend `toml:"backend" json:"backend" jsonschema:"description=Configure one of the supported backends: \u0060postgres\u0060, \u0060bigquery\u0060.,default=bigquery"`
		GcpProjectId     string          `toml:"gcp_project_id" json:"gcp_project_id"`
		GcpProjectNumber string          `toml:"gcp_project_number" json:"gcp_project_number"`
		GcpJwtPath       string          `toml:"gcp_jwt_path" json:"gcp_jwt_path"`
		ApiKey           string          `toml:"-" json:"-" mapstructure:"api_key" jsonschema:"default=api-key"`
		VectorPort       uint16          `toml:"vector_port" json:"vector_port" jsonschema:"description=Port to the local syslog ingest service.,default=54327"`
	}

	experimental struct {
		OrioleDBVersion string `toml:"orioledb_version" json:"orioledb_version"`
		S3Host          string `toml:"s3_host" json:"s3_host"`
		S3Region        string `toml:"s3_region" json:"s3_region"`
		S3AccessKey     string `toml:"s3_access_key" json:"s3_access_key"`
		S3SecretKey     string `toml:"s3_secret_key" json:"s3_secret_key"`
	}
)

type ConfigEditor func(*config)

func WithHostname(hostname string) ConfigEditor {
	return func(c *config) {
		c.Hostname = hostname
	}
}

func NewConfig(editors ...ConfigEditor) config {
	initial := config{
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
				Enabled: true,
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
	}
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
	envPattern       = regexp.MustCompile(`^env\((.*)\)$`)
)

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
	// Load user defined config
	if metadata, err := toml.DecodeFS(fsys, builder.ConfigPath, c); err != nil {
		cwd, osErr := os.Getwd()
		if osErr != nil {
			cwd = "current directory"
		}
		return errors.Errorf("cannot read config in %s: %w", cwd, err)
	} else if undecoded := metadata.Undecoded(); len(undecoded) > 0 {
		fmt.Fprintf(os.Stderr, "Unknown config fields: %+v\n", undecoded)
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
	return c.Validate()
}

func (c *config) Validate() error {
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
			if len(tmpl.ContentPath) > 0 && !fs.ValidPath(filepath.Clean(tmpl.ContentPath)) {
				return errors.Errorf("Invalid config for auth.email.%s.content_path: %s", name, tmpl.ContentPath)
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

func validateHookURI(uri, hookName string) error {
	parsed, err := url.Parse(uri)
	if err != nil {
		return errors.Errorf("failed to parse template url: %w", err)
	}
	if !(parsed.Scheme == "http" || parsed.Scheme == "https" || parsed.Scheme == "pg-functions") {
		return errors.Errorf("Invalid HTTP hook config: auth.hook.%v should be a Postgres function URI, or a HTTP or HTTPS URL", hookName)
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

func GenerateConfigJSONSchema() (string, error) {
	// Create a new reflector
	r := &jsonschema.Reflector{
		RequiredFromJSONSchemaTags: true,
		// Set any custom options here if needed
		// For example:
		// ExpandedStruct: true,
	}

	// Generate the schema for the config struct
	schema := r.Reflect(&config{})

	// Marshal the schema to JSON
	schemaJSON, err := json.MarshalIndent(schema, "", "  ")
	if err != nil {
		return "", errors.Errorf("failed to marshal JSON schema: %w", err)
	}

	return string(schemaJSON), nil
}
