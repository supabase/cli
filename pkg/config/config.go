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
	"regexp"
	"sort"
	"strconv"
	"strings"
	"text/template"
	"time"

	"github.com/BurntSushi/toml"
	"github.com/docker/go-units"
	"github.com/go-errors/errors"
	"github.com/golang-jwt/jwt/v5"
	"github.com/joho/godotenv"
	"github.com/mitchellh/mapstructure"
	"github.com/spf13/viper"
	"github.com/supabase/cli/pkg/cast"
	"github.com/supabase/cli/pkg/fetcher"
	"golang.org/x/mod/semver"
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
	// Common config fields between our "base" config and any "remote" branch specific
	baseConfig struct {
		ProjectId    string         `toml:"project_id"`
		Hostname     string         `toml:"-"`
		Api          api            `toml:"api"`
		Db           db             `toml:"db" mapstructure:"db"`
		Realtime     realtime       `toml:"realtime"`
		Studio       studio         `toml:"studio"`
		Inbucket     inbucket       `toml:"inbucket"`
		Storage      storage        `toml:"storage"`
		Auth         auth           `toml:"auth" mapstructure:"auth"`
		EdgeRuntime  edgeRuntime    `toml:"edge_runtime"`
		Functions    FunctionConfig `toml:"functions"`
		Analytics    analytics      `toml:"analytics"`
		Experimental experimental   `toml:"experimental"`
	}

	config struct {
		baseConfig `mapstructure:",squash"`
		Overrides  map[string]interface{} `toml:"remotes"`
		Remotes    map[string]baseConfig  `toml:"-"`
	}

	realtime struct {
		Enabled         bool          `toml:"enabled"`
		Image           string        `toml:"-"`
		IpVersion       AddressFamily `toml:"ip_version"`
		MaxHeaderLength uint          `toml:"max_header_length"`
		TenantId        string        `toml:"-"`
		EncryptionKey   string        `toml:"-"`
		SecretKeyBase   string        `toml:"-"`
	}

	studio struct {
		Enabled      bool   `toml:"enabled"`
		Image        string `toml:"-"`
		Port         uint16 `toml:"port"`
		ApiUrl       string `toml:"api_url"`
		OpenaiApiKey string `toml:"openai_api_key"`
		PgmetaImage  string `toml:"-"`
	}

	inbucket struct {
		Enabled    bool   `toml:"enabled"`
		Image      string `toml:"-"`
		Port       uint16 `toml:"port"`
		SmtpPort   uint16 `toml:"smtp_port"`
		Pop3Port   uint16 `toml:"pop3_port"`
		AdminEmail string `toml:"admin_email"`
		SenderName string `toml:"sender_name"`
	}

	edgeRuntime struct {
		Enabled       bool          `toml:"enabled"`
		Image         string        `toml:"-"`
		Policy        RequestPolicy `toml:"policy"`
		InspectorPort uint16        `toml:"inspector_port"`
	}

	FunctionConfig map[string]function

	function struct {
		Enabled    *bool  `toml:"enabled" json:"-"`
		VerifyJWT  *bool  `toml:"verify_jwt" json:"verifyJWT"`
		ImportMap  string `toml:"import_map" json:"importMapPath,omitempty"`
		Entrypoint string `toml:"entrypoint" json:"entrypointPath,omitempty"`
	}

	analytics struct {
		Enabled          bool            `toml:"enabled"`
		Image            string          `toml:"-"`
		VectorImage      string          `toml:"-"`
		Port             uint16          `toml:"port"`
		Backend          LogflareBackend `toml:"backend"`
		GcpProjectId     string          `toml:"gcp_project_id"`
		GcpProjectNumber string          `toml:"gcp_project_number"`
		GcpJwtPath       string          `toml:"gcp_jwt_path"`
		ApiKey           string          `toml:"-" mapstructure:"api_key"`
		// Deprecated together with syslog
		VectorPort uint16 `toml:"vector_port"`
	}

	webhooks struct {
		Enabled bool `toml:"enabled"`
	}

	experimental struct {
		OrioleDBVersion string    `toml:"orioledb_version"`
		S3Host          string    `toml:"s3_host"`
		S3Region        string    `toml:"s3_region"`
		S3AccessKey     string    `toml:"s3_access_key"`
		S3SecretKey     string    `toml:"s3_secret_key"`
		Webhooks        *webhooks `toml:"webhooks"`
	}
)

func (f function) IsEnabled() bool {
	// If Enabled is not defined, or defined and set to true
	return f.Enabled == nil || *f.Enabled
}

func (a *auth) Clone() auth {
	copy := *a
	copy.External = maps.Clone(a.External)
	if a.Email.Smtp != nil {
		mailer := *a.Email.Smtp
		copy.Email.Smtp = &mailer
	}
	if a.Hook.MFAVerificationAttempt != nil {
		hook := *a.Hook.MFAVerificationAttempt
		copy.Hook.MFAVerificationAttempt = &hook
	}
	if a.Hook.PasswordVerificationAttempt != nil {
		hook := *a.Hook.PasswordVerificationAttempt
		copy.Hook.PasswordVerificationAttempt = &hook
	}
	if a.Hook.CustomAccessToken != nil {
		hook := *a.Hook.CustomAccessToken
		copy.Hook.CustomAccessToken = &hook
	}
	if a.Hook.SendSMS != nil {
		hook := *a.Hook.SendSMS
		copy.Hook.SendSMS = &hook
	}
	if a.Hook.SendEmail != nil {
		hook := *a.Hook.SendEmail
		copy.Hook.SendEmail = &hook
	}
	copy.Email.Template = maps.Clone(a.Email.Template)
	copy.Sms.TestOTP = maps.Clone(a.Sms.TestOTP)
	return copy
}

func (c *baseConfig) Clone() baseConfig {
	copy := *c
	copy.Storage.Buckets = maps.Clone(c.Storage.Buckets)
	copy.Functions = maps.Clone(c.Functions)
	copy.Auth = c.Auth.Clone()
	if c.Experimental.Webhooks != nil {
		webhooks := *c.Experimental.Webhooks
		copy.Experimental.Webhooks = &webhooks
	}
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
			Image:         storageImage,
			ImgProxyImage: imageProxyImage,
			S3Credentials: storageS3Credentials{
				AccessKeyId:     "625729a08b95bf1b7ff351a663f3a23c",
				SecretAccessKey: "850181e4652dd023b7a98c58ae0d2d34bd487ee0cc3254aed6eda37307425907",
				Region:          "local",
			},
		},
		Auth: auth{
			Image: gotrueImage,
			Email: email{
				Template: map[string]emailTemplate{
					"invite":           {},
					"confirmation":     {},
					"recovery":         {},
					"magic_link":       {},
					"email_change":     {},
					"reauthentication": {},
				},
			},
			Sms: sms{
				TestOTP: map[string]string{},
			},
			External:  map[string]provider{},
			JwtSecret: defaultJwtSecret,
		},
		Inbucket: inbucket{
			Image:      inbucketImage,
			AdminEmail: "admin@email.com",
			SenderName: "Admin",
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

func (c *config) loadFromEnv() error {
	// Allow overriding base config object with automatic env
	// Ref: https://github.com/spf13/viper/issues/761
	envKeysMap := map[string]interface{}{}
	if dec, err := mapstructure.NewDecoder(&mapstructure.DecoderConfig{
		Result:               &envKeysMap,
		IgnoreUntaggedFields: true,
	}); err != nil {
		return errors.Errorf("failed to create decoder: %w", err)
	} else if err := dec.Decode(c.baseConfig); err != nil {
		return errors.Errorf("failed to decode env: %w", err)
	}
	v := viper.New()
	v.SetEnvPrefix("SUPABASE")
	v.SetEnvKeyReplacer(strings.NewReplacer(".", "_"))
	v.AutomaticEnv()
	if err := v.MergeConfigMap(envKeysMap); err != nil {
		return errors.Errorf("failed to merge config: %w", err)
	} else if err := v.Unmarshal(c); err != nil {
		return errors.Errorf("failed to parse env to config: %w", err)
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
	} else if err := c.loadFromEnv(); err != nil {
		return err
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
	// Update content paths
	for name, tmpl := range c.Auth.Email.Template {
		// FIXME: only email template is relative to repo directory
		cwd := filepath.Dir(builder.SupabaseDirPath)
		if len(tmpl.ContentPath) > 0 && !filepath.IsAbs(tmpl.ContentPath) {
			tmpl.ContentPath = filepath.Join(cwd, tmpl.ContentPath)
		}
		c.Auth.Email.Template[name] = tmpl
	}
	// Update fallback configs
	for name, bucket := range c.Storage.Buckets {
		if bucket.FileSizeLimit == 0 {
			bucket.FileSizeLimit = c.Storage.FileSizeLimit
		}
		if len(bucket.ObjectsPath) > 0 && !filepath.IsAbs(bucket.ObjectsPath) {
			bucket.ObjectsPath = filepath.Join(builder.SupabaseDirPath, bucket.ObjectsPath)
		}
		c.Storage.Buckets[name] = bucket
	}
	// Resolve functions config
	for slug, function := range c.Functions {
		if len(function.Entrypoint) == 0 {
			function.Entrypoint = filepath.Join(builder.FunctionsDir, slug, "index.ts")
		} else if !filepath.IsAbs(function.Entrypoint) {
			// Append supabase/ because paths in configs are specified relative to config.toml
			function.Entrypoint = filepath.Join(builder.SupabaseDirPath, function.Entrypoint)
		}
		if len(function.ImportMap) == 0 {
			functionDir := filepath.Dir(function.Entrypoint)
			denoJsonPath := filepath.Join(functionDir, "deno.json")
			denoJsoncPath := filepath.Join(functionDir, "deno.jsonc")
			if _, err := fs.Stat(fsys, denoJsonPath); err == nil {
				function.ImportMap = denoJsonPath
			} else if _, err := fs.Stat(fsys, denoJsoncPath); err == nil {
				function.ImportMap = denoJsoncPath
			}
			// Functions may not use import map so we don't set a default value
		} else if !filepath.IsAbs(function.ImportMap) {
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
	idToName := map[string]string{}
	c.Remotes = make(map[string]baseConfig, len(c.Overrides))
	for name, remote := range c.Overrides {
		base := c.baseConfig.Clone()
		// On remotes branches set seed as disabled by default
		base.Db.Seed.Enabled = false
		// Encode a toml file with only config overrides
		var buf bytes.Buffer
		if err := toml.NewEncoder(&buf).Encode(remote); err != nil {
			return errors.Errorf("failed to encode map to TOML: %w", err)
		}
		// Decode overrides using base config as defaults
		if metadata, err := toml.NewDecoder(&buf).Decode(&base); err != nil {
			return errors.Errorf("failed to decode remote config: %w", err)
		} else if undecoded := metadata.Undecoded(); len(undecoded) > 0 {
			fmt.Fprintf(os.Stderr, "WARN: unknown config fields: %+v\n", undecoded)
		}
		// Cross validate remote project id
		if base.ProjectId == c.baseConfig.ProjectId {
			fmt.Fprintf(os.Stderr, "WARN: project_id is missing for [remotes.%s]\n", name)
		} else if other, exists := idToName[base.ProjectId]; exists {
			return errors.Errorf("duplicate project_id for [remotes.%s] and [remotes.%s]", other, name)
		} else {
			idToName[base.ProjectId] = name
		}
		if err := base.Validate(fsys); err != nil {
			return errors.Errorf("invalid config for [remotes.%s]: %w", name, err)
		}
		c.Remotes[name] = base
	}
	return nil
}

func (c *baseConfig) Validate(fsys fs.FS) error {
	if c.ProjectId == "" {
		return errors.New("Missing required field in config: project_id")
	} else if sanitized := sanitizeProjectId(c.ProjectId); sanitized != c.ProjectId {
		fmt.Fprintln(os.Stderr, "WARN: project_id field in config is invalid. Auto-fixing to", sanitized)
		c.ProjectId = sanitized
	}
	// Validate api config
	if c.Api.Enabled {
		if c.Api.Port == 0 {
			return errors.New("Missing required field in config: api.port")
		}
	}
	// Validate db config
	if c.Db.Settings.SessionReplicationRole != nil {
		allowedRoles := []SessionReplicationRole{SessionReplicationRoleOrigin, SessionReplicationRoleReplica, SessionReplicationRoleLocal}
		if !sliceContains(allowedRoles, *c.Db.Settings.SessionReplicationRole) {
			return errors.Errorf("Invalid config for db.session_replication_role: %s. Must be one of: %v", *c.Db.Settings.SessionReplicationRole, allowedRoles)
		}
	}
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
		for i, url := range c.Auth.AdditionalRedirectUrls {
			if c.Auth.AdditionalRedirectUrls[i], err = maybeLoadEnv(url); err != nil {
				return errors.Errorf("Invalid config for auth.additional_redirect_urls[%d]: %v", i, err)
			}
		}
		allowed := []PasswordRequirements{NoRequirements, LettersDigits, LowerUpperLettersDigits, LowerUpperLettersDigitsSymbols}
		if !sliceContains(allowed, c.Auth.PasswordRequirements) {
			return errors.Errorf("Invalid config for auth.password_requirements. Must be one of: %v", allowed)
		}
		if err := c.Auth.Hook.validate(); err != nil {
			return err
		}
		if err := c.Auth.MFA.validate(); err != nil {
			return err
		}
		if err := c.Auth.Email.validate(fsys); err != nil {
			return err
		}
		if err := c.Auth.Sms.validate(); err != nil {
			return err
		}
		if err := c.Auth.External.validate(); err != nil {
			return err
		}
		if err := c.Auth.ThirdParty.validate(); err != nil {
			return err
		}
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
	if err := c.Experimental.validate(); err != nil {
		return err
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
			fmt.Fprintln(os.Stderr, "WARN: no seed files matched pattern:", pattern)
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

func (e *email) validate(fsys fs.FS) (err error) {
	for name, tmpl := range e.Template {
		if len(tmpl.ContentPath) == 0 {
			if tmpl.Content != nil {
				return errors.Errorf("Invalid config for auth.email.%s.content: please use content_path instead", name)
			}
			continue
		}
		if content, err := fs.ReadFile(fsys, tmpl.ContentPath); err != nil {
			return errors.Errorf("Invalid config for auth.email.%s.content_path: %w", name, err)
		} else {
			tmpl.Content = cast.Ptr(string(content))
		}
		e.Template[name] = tmpl
	}
	if e.Smtp != nil && e.Smtp.IsEnabled() {
		if len(e.Smtp.Host) == 0 {
			return errors.New("Missing required field in config: auth.email.smtp.host")
		}
		if e.Smtp.Port == 0 {
			return errors.New("Missing required field in config: auth.email.smtp.port")
		}
		if len(e.Smtp.User) == 0 {
			return errors.New("Missing required field in config: auth.email.smtp.user")
		}
		if len(e.Smtp.Pass) == 0 {
			return errors.New("Missing required field in config: auth.email.smtp.pass")
		}
		if len(e.Smtp.AdminEmail) == 0 {
			return errors.New("Missing required field in config: auth.email.smtp.admin_email")
		}
		if e.Smtp.Pass, err = maybeLoadEnv(e.Smtp.Pass); err != nil {
			return err
		}
	}
	return nil
}

func (s *sms) validate() (err error) {
	switch {
	case s.Twilio.Enabled:
		if len(s.Twilio.AccountSid) == 0 {
			return errors.New("Missing required field in config: auth.sms.twilio.account_sid")
		}
		if len(s.Twilio.MessageServiceSid) == 0 {
			return errors.New("Missing required field in config: auth.sms.twilio.message_service_sid")
		}
		if len(s.Twilio.AuthToken) == 0 {
			return errors.New("Missing required field in config: auth.sms.twilio.auth_token")
		}
		if s.Twilio.AuthToken, err = maybeLoadEnv(s.Twilio.AuthToken); err != nil {
			return err
		}
	case s.TwilioVerify.Enabled:
		if len(s.TwilioVerify.AccountSid) == 0 {
			return errors.New("Missing required field in config: auth.sms.twilio_verify.account_sid")
		}
		if len(s.TwilioVerify.MessageServiceSid) == 0 {
			return errors.New("Missing required field in config: auth.sms.twilio_verify.message_service_sid")
		}
		if len(s.TwilioVerify.AuthToken) == 0 {
			return errors.New("Missing required field in config: auth.sms.twilio_verify.auth_token")
		}
		if s.TwilioVerify.AuthToken, err = maybeLoadEnv(s.TwilioVerify.AuthToken); err != nil {
			return err
		}
	case s.Messagebird.Enabled:
		if len(s.Messagebird.Originator) == 0 {
			return errors.New("Missing required field in config: auth.sms.messagebird.originator")
		}
		if len(s.Messagebird.AccessKey) == 0 {
			return errors.New("Missing required field in config: auth.sms.messagebird.access_key")
		}
		if s.Messagebird.AccessKey, err = maybeLoadEnv(s.Messagebird.AccessKey); err != nil {
			return err
		}
	case s.Textlocal.Enabled:
		if len(s.Textlocal.Sender) == 0 {
			return errors.New("Missing required field in config: auth.sms.textlocal.sender")
		}
		if len(s.Textlocal.ApiKey) == 0 {
			return errors.New("Missing required field in config: auth.sms.textlocal.api_key")
		}
		if s.Textlocal.ApiKey, err = maybeLoadEnv(s.Textlocal.ApiKey); err != nil {
			return err
		}
	case s.Vonage.Enabled:
		if len(s.Vonage.From) == 0 {
			return errors.New("Missing required field in config: auth.sms.vonage.from")
		}
		if len(s.Vonage.ApiKey) == 0 {
			return errors.New("Missing required field in config: auth.sms.vonage.api_key")
		}
		if len(s.Vonage.ApiSecret) == 0 {
			return errors.New("Missing required field in config: auth.sms.vonage.api_secret")
		}
		if s.Vonage.ApiKey, err = maybeLoadEnv(s.Vonage.ApiKey); err != nil {
			return err
		}
		if s.Vonage.ApiSecret, err = maybeLoadEnv(s.Vonage.ApiSecret); err != nil {
			return err
		}
	case s.EnableSignup:
		s.EnableSignup = false
		fmt.Fprintln(os.Stderr, "WARN: no SMS provider is enabled. Disabling phone login")
	}
	return nil
}

func (e external) validate() (err error) {
	for _, ext := range []string{"linkedin", "slack"} {
		if e[ext].Enabled {
			fmt.Fprintf(os.Stderr, `WARN: disabling deprecated "%[1]s" provider. Please use [auth.external.%[1]s_oidc] instead\n`, ext)
		}
		delete(e, ext)
	}
	for ext, provider := range e {
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
		e[ext] = provider
	}
	return nil
}

func (h *hook) validate() error {
	if hook := h.MFAVerificationAttempt; hook != nil {
		if err := hook.validate("mfa_verification_attempt"); err != nil {
			return err
		}
	}
	if hook := h.PasswordVerificationAttempt; hook != nil {
		if err := hook.validate("password_verification_attempt"); err != nil {
			return err
		}
	}
	if hook := h.CustomAccessToken; hook != nil {
		if err := hook.validate("custom_access_token"); err != nil {
			return err
		}
	}
	if hook := h.SendSMS; hook != nil {
		if err := hook.validate("send_sms"); err != nil {
			return err
		}
	}
	if hook := h.SendEmail; hook != nil {
		if err := h.SendEmail.validate("send_email"); err != nil {
			return err
		}
	}
	return nil
}

var hookSecretPattern = regexp.MustCompile(`^v1,whsec_[A-Za-z0-9+/=]{32,88}$`)

func (h *hookConfig) validate(hookType string) (err error) {
	// If not enabled do nothing
	if !h.Enabled {
		return nil
	}
	if h.URI == "" {
		return errors.Errorf("Missing required field in config: auth.hook.%s.uri", hookType)
	}
	parsed, err := url.Parse(h.URI)
	if err != nil {
		return errors.Errorf("failed to parse template url: %w", err)
	}
	switch strings.ToLower(parsed.Scheme) {
	case "http", "https":
		if len(h.Secrets) == 0 {
			return errors.Errorf("Missing required field in config: auth.hook.%s.secrets", hookType)
		} else if h.Secrets, err = maybeLoadEnv(h.Secrets); err != nil {
			return err
		}
		for _, secret := range strings.Split(h.Secrets, "|") {
			if !hookSecretPattern.MatchString(secret) {
				return errors.Errorf(`Invalid hook config: auth.hook.%s.secrets must be formatted as "v1,whsec_<base64_encoded_secret>"`, hookType)
			}
		}
	case "pg-functions":
		if len(h.Secrets) > 0 {
			return errors.Errorf("Invalid hook config: auth.hook.%s.secrets is unsupported for pg-functions URI", hookType)
		}
	default:
		return errors.Errorf("Invalid hook config: auth.hook.%s.uri should be a HTTP, HTTPS, or pg-functions URI", hookType)
	}
	return nil
}

func (m *mfa) validate() error {
	if m.TOTP.EnrollEnabled && !m.TOTP.VerifyEnabled {
		return errors.Errorf("Invalid MFA config: auth.mfa.totp.enroll_enabled requires verify_enabled")
	}
	if m.Phone.EnrollEnabled && !m.Phone.VerifyEnabled {
		return errors.Errorf("Invalid MFA config: auth.mfa.phone.enroll_enabled requires verify_enabled")
	}
	if m.WebAuthn.EnrollEnabled && !m.WebAuthn.VerifyEnabled {
		return errors.Errorf("Invalid MFA config: auth.mfa.web_authn.enroll_enabled requires verify_enabled")
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

func (c *tpaCognito) validate() (err error) {
	if c.UserPoolID == "" {
		return errors.New("Invalid config: auth.third_party.cognito is enabled but without a user_pool_id.")
	} else if c.UserPoolID, err = maybeLoadEnv(c.UserPoolID); err != nil {
		return err
	}

	if c.UserPoolRegion == "" {
		return errors.New("Invalid config: auth.third_party.cognito is enabled but without a user_pool_region.")
	} else if c.UserPoolRegion, err = maybeLoadEnv(c.UserPoolRegion); err != nil {
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

func (c *baseConfig) GetServiceImages() []string {
	return []string{
		c.Db.Image,
		c.Auth.Image,
		c.Api.Image,
		c.Realtime.Image,
		c.Storage.Image,
		c.EdgeRuntime.Image,
		c.Studio.Image,
		c.Studio.PgmetaImage,
		c.Analytics.Image,
		c.Db.Pooler.Image,
	}
}

// Retrieve the final base config to use taking into account the remotes override
func (c *config) GetRemoteByProjectRef(projectRef string) (baseConfig, error) {
	var result []string
	// Iterate over all the config.Remotes
	for name, remoteConfig := range c.Remotes {
		// Check if there is one matching project_id
		if remoteConfig.ProjectId == projectRef {
			// Check for duplicate project IDs across remotes
			result = append(result, name)
		}
	}
	// If no matching remote config is found, return the base config
	if len(result) == 0 {
		return c.baseConfig, errors.Errorf("no remote found for project_id: %s", projectRef)
	}
	remote := c.Remotes[result[0]]
	if len(result) > 1 {
		return remote, errors.Errorf("multiple remotes %v have the same project_id: %s", result, projectRef)
	}
	return remote, nil
}

func ToTomlBytes(config any) ([]byte, error) {
	var buf bytes.Buffer
	enc := toml.NewEncoder(&buf)
	enc.Indent = ""
	if err := enc.Encode(config); err != nil {
		return nil, errors.Errorf("failed to marshal toml config: %w", err)
	}
	return buf.Bytes(), nil
}

func (e *experimental) validate() error {
	if e.Webhooks != nil && !e.Webhooks.Enabled {
		return errors.Errorf("Webhooks cannot be deactivated. [experimental.webhooks] enabled can either be true or left undefined")
	}
	return nil
}
