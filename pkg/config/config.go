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
	"github.com/go-viper/mapstructure/v2"
	"github.com/golang-jwt/jwt/v5"
	"github.com/joho/godotenv"
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

func (b *LogflareBackend) UnmarshalText(text []byte) error {
	allowed := []LogflareBackend{LogflarePostgres, LogflareBigQuery}
	if *b = LogflareBackend(text); !sliceContains(allowed, *b) {
		return errors.Errorf("must be one of %v", allowed)
	}
	return nil
}

type AddressFamily string

const (
	AddressIPv6 AddressFamily = "IPv6"
	AddressIPv4 AddressFamily = "IPv4"
)

func (f *AddressFamily) UnmarshalText(text []byte) error {
	allowed := []AddressFamily{AddressIPv6, AddressIPv4}
	if *f = AddressFamily(text); !sliceContains(allowed, *f) {
		return errors.Errorf("must be one of %v", allowed)
	}
	return nil
}

type RequestPolicy string

const (
	PolicyPerWorker RequestPolicy = "per_worker"
	PolicyOneshot   RequestPolicy = "oneshot"
)

func (p *RequestPolicy) UnmarshalText(text []byte) error {
	allowed := []RequestPolicy{PolicyPerWorker, PolicyOneshot}
	if *p = RequestPolicy(text); !sliceContains(allowed, *p) {
		return errors.Errorf("must be one of %v", allowed)
	}
	return nil
}

type Glob []string

// Match the glob patterns in the given FS to get a deduplicated
// array of all migrations files to apply in the declared order.
func (g Glob) Files(fsys fs.FS) ([]string, error) {
	var result []string
	var allErrors []error
	set := make(map[string]struct{})
	for _, pattern := range g {
		// Glob expects / as path separator on windows
		matches, err := fs.Glob(fsys, filepath.ToSlash(pattern))
		if err != nil {
			allErrors = append(allErrors, errors.Errorf("failed to glob files: %w", err))
		} else if len(matches) == 0 {
			allErrors = append(allErrors, errors.Errorf("no files matched pattern: %s", pattern))
		}
		sort.Strings(matches)
		// Remove duplicates
		for _, item := range matches {
			fp := filepath.ToSlash(item)
			if _, exists := set[fp]; !exists {
				set[fp] = struct{}{}
				result = append(result, fp)
			}
		}
	}
	return result, errors.Join(allErrors...)
}

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
// Default values for internal configs should be added to `var Config` initializer.
type (
	// Common config fields between our "base" config and any "remote" branch specific
	baseConfig struct {
		ProjectId    string         `toml:"project_id"`
		Hostname     string         `toml:"-"`
		Api          api            `toml:"api"`
		Db           db             `toml:"db"`
		Realtime     realtime       `toml:"realtime"`
		Studio       studio         `toml:"studio"`
		Inbucket     inbucket       `toml:"inbucket"`
		Storage      storage        `toml:"storage"`
		Auth         auth           `toml:"auth"`
		EdgeRuntime  edgeRuntime    `toml:"edge_runtime"`
		Functions    FunctionConfig `toml:"functions"`
		Analytics    analytics      `toml:"analytics"`
		Experimental experimental   `toml:"experimental"`
	}

	config struct {
		baseConfig
		Remotes map[string]baseConfig `toml:"remotes"`
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
		OpenaiApiKey Secret `toml:"openai_api_key"`
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
		Secrets       SecretsConfig `toml:"secrets"`
		DenoVersion   uint          `toml:"deno_version"`
	}

	SecretsConfig  map[string]Secret
	FunctionConfig map[string]function

	function struct {
		Enabled     bool   `toml:"enabled" json:"-"`
		VerifyJWT   bool   `toml:"verify_jwt" json:"verifyJWT"`
		ImportMap   string `toml:"import_map" json:"importMapPath,omitempty"`
		Entrypoint  string `toml:"entrypoint" json:"entrypointPath,omitempty"`
		StaticFiles Glob   `toml:"static_files" json:"staticFiles,omitempty"`
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
		ApiKey           string          `toml:"-"`
		// Deprecated together with syslog
		VectorPort uint16 `toml:"vector_port"`
	}

	webhooks struct {
		Enabled bool `toml:"enabled"`
	}

	inspect struct {
		Rules []rule `toml:"rules"`
	}

	rule struct {
		Query string `toml:"query"`
		Name  string `toml:"name"`
		Pass  string `toml:"pass"`
		Fail  string `toml:"fail"`
	}

	experimental struct {
		OrioleDBVersion string    `toml:"orioledb_version"`
		S3Host          string    `toml:"s3_host"`
		S3Region        string    `toml:"s3_region"`
		S3AccessKey     string    `toml:"s3_access_key"`
		S3SecretKey     string    `toml:"s3_secret_key"`
		Webhooks        *webhooks `toml:"webhooks"`
		Inspect         inspect   `toml:"inspect"`
	}
)

func (a *auth) Clone() auth {
	copy := *a
	if copy.Captcha != nil {
		capt := *a.Captcha
		copy.Captcha = &capt
	}
	copy.External = maps.Clone(a.External)
	if a.Email.Smtp != nil {
		mailer := *a.Email.Smtp
		copy.Email.Smtp = &mailer
	}
	copy.Email.Template = maps.Clone(a.Email.Template)
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
	if a.Hook.BeforeUserCreated != nil {
		hook := *a.Hook.BeforeUserCreated
		copy.Hook.BeforeUserCreated = &hook
	}
	copy.Sms.TestOTP = maps.Clone(a.Sms.TestOTP)
	return copy
}

func (s *storage) Clone() storage {
	copy := *s
	copy.Buckets = maps.Clone(s.Buckets)
	if s.ImageTransformation != nil {
		img := *s.ImageTransformation
		copy.ImageTransformation = &img
	}
	return copy
}

func (c *baseConfig) Clone() baseConfig {
	copy := *c
	copy.Db.Vault = maps.Clone(c.Db.Vault)
	copy.Storage = c.Storage.Clone()
	copy.EdgeRuntime.Secrets = maps.Clone(c.EdgeRuntime.Secrets)
	copy.Functions = maps.Clone(c.Functions)
	copy.Auth = c.Auth.Clone()
	if c.Experimental.Webhooks != nil {
		webhooks := *c.Experimental.Webhooks
		copy.Experimental.Webhooks = &webhooks
	}
	return copy
}

type Config *config

type ConfigEditor func(Config)

func WithHostname(hostname string) ConfigEditor {
	return func(c Config) {
		c.Hostname = hostname
	}
}

func NewConfig(editors ...ConfigEditor) config {
	initial := config{baseConfig: baseConfig{
		Hostname: "127.0.0.1",
		Api: api{
			Image:     Images.Postgrest,
			KongImage: Images.Kong,
		},
		Db: db{
			Image:    Images.Pg,
			Password: "postgres",
			RootKey: Secret{
				Value: "d4dc5b6d4a1d6a10b2c1e76112c994d65db7cec380572cc1839624d4be3fa275",
			},
			Pooler: pooler{
				Image:         Images.Supavisor,
				TenantId:      "pooler-dev",
				EncryptionKey: "12345678901234567890123456789032",
				SecretKeyBase: "EAx3IQ/wRG1v47ZD4NE4/9RzBI8Jmil3x0yhcW4V2NHBP6c2iPIzwjofi2Ep4HIG",
			},
			Migrations: migrations{
				Enabled: true,
			},
			Seed: seed{
				Enabled:  true,
				SqlPaths: []string{"seed.sql"},
			},
		},
		Realtime: realtime{
			Image:           Images.Realtime,
			IpVersion:       AddressIPv4,
			MaxHeaderLength: 4096,
			TenantId:        "realtime-dev",
			EncryptionKey:   "supabaserealtime",
			SecretKeyBase:   "EAx3IQ/wRG1v47ZD4NE4/9RzBI8Jmil3x0yhcW4V2NHBP6c2iPIzwjofi2Ep4HIG",
		},
		Storage: storage{
			Image:         Images.Storage,
			ImgProxyImage: Images.ImgProxy,
			S3Credentials: storageS3Credentials{
				AccessKeyId:     "625729a08b95bf1b7ff351a663f3a23c",
				SecretAccessKey: "850181e4652dd023b7a98c58ae0d2d34bd487ee0cc3254aed6eda37307425907",
				Region:          "local",
			},
		},
		Auth: auth{
			Image: Images.Gotrue,
			Email: email{
				Template: map[string]emailTemplate{},
			},
			Sms: sms{
				TestOTP: map[string]string{},
			},
			External: map[string]provider{},
			JwtSecret: Secret{
				Value: defaultJwtSecret,
			},
		},
		Inbucket: inbucket{
			Image:      Images.Inbucket,
			AdminEmail: "admin@email.com",
			SenderName: "Admin",
		},
		Studio: studio{
			Image:       Images.Studio,
			PgmetaImage: Images.Pgmeta,
		},
		Analytics: analytics{
			Image:       Images.Logflare,
			VectorImage: Images.Vector,
			ApiKey:      "api-key",
			// Defaults to bigquery for backwards compatibility with existing config.toml
			Backend: LogflareBigQuery,
		},
		EdgeRuntime: edgeRuntime{
			Image: Images.EdgeRuntime,
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
	refPattern       = regexp.MustCompile(`^[a-z]{20}$`)
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

// Loads custom config file to struct fields tagged with toml.
func (c *config) loadFromFile(filename string, fsys fs.FS) error {
	v := viper.NewWithOptions(
		viper.ExperimentalBindStruct(),
		viper.EnvKeyReplacer(strings.NewReplacer(".", "_")),
	)
	v.SetEnvPrefix("SUPABASE")
	v.AutomaticEnv()
	if err := c.mergeDefaultValues(v); err != nil {
		return err
	} else if err := mergeFileConfig(v, filename, fsys); err != nil {
		return err
	}
	// Find [remotes.*] block to override base config
	idToName := map[string]string{}
	for name, remote := range v.GetStringMap("remotes") {
		projectId := v.GetString(fmt.Sprintf("remotes.%s.project_id", name))
		// Track remote project_id to check for duplication
		if other, exists := idToName[projectId]; exists {
			return errors.Errorf("duplicate project_id for [remotes.%s] and %s", name, other)
		}
		idToName[projectId] = fmt.Sprintf("[remotes.%s]", name)
		if projectId == c.ProjectId {
			fmt.Fprintln(os.Stderr, "Loading config override:", idToName[projectId])
			if err := mergeRemoteConfig(v, remote.(map[string]any)); err != nil {
				return err
			}
		}
	}
	return c.load(v)
}

func (c *config) mergeDefaultValues(v *viper.Viper) error {
	v.SetConfigType("toml")
	var buf bytes.Buffer
	if err := c.Eject(&buf); err != nil {
		return err
	} else if err := v.MergeConfig(&buf); err != nil {
		return errors.Errorf("failed to merge default values: %w", err)
	}
	return nil
}

func mergeFileConfig(v *viper.Viper, filename string, fsys fs.FS) error {
	if ext := filepath.Ext(filename); len(ext) > 0 {
		v.SetConfigType(ext[1:])
	}
	f, err := fsys.Open(filename)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	} else if err != nil {
		return errors.Errorf("failed to read file config: %w", err)
	}
	defer f.Close()
	if err := v.MergeConfig(f); err != nil {
		return errors.Errorf("failed to merge file config: %w", err)
	}
	return nil
}

func mergeRemoteConfig(v *viper.Viper, remote map[string]any) error {
	u := viper.New()
	if err := u.MergeConfigMap(remote); err != nil {
		return errors.Errorf("failed to merge remote config: %w", err)
	}
	for _, k := range u.AllKeys() {
		v.Set(k, u.Get(k))
	}
	if key := "db.seed.enabled"; !u.IsSet(key) {
		v.Set(key, false)
	}
	return nil
}

func (c *config) load(v *viper.Viper) error {
	// Set default values for [functions.*] when config struct is empty
	for key, value := range v.GetStringMap("functions") {
		if _, ok := value.(map[string]any); !ok {
			// Leave validation to decode hook
			continue
		}
		if k := fmt.Sprintf("functions.%s.enabled", key); !v.IsSet(k) {
			v.Set(k, true)
		}
		if k := fmt.Sprintf("functions.%s.verify_jwt", key); !v.IsSet(k) {
			v.Set(k, true)
		}
	}
	// Set default values when [auth.email.smtp] is defined
	if smtp := v.GetStringMap("auth.email.smtp"); len(smtp) > 0 {
		if _, exists := smtp["enabled"]; !exists {
			v.Set("auth.email.smtp.enabled", true)
		}
	}
	if err := v.UnmarshalExact(c, func(dc *mapstructure.DecoderConfig) {
		dc.TagName = "toml"
		dc.Squash = true
		dc.ZeroFields = true
		dc.DecodeHook = c.newDecodeHook(LoadEnvHook, ValidateFunctionsHook)
	}); err != nil {
		return errors.Errorf("failed to parse config: %w", err)
	}
	// Convert keys to upper case: https://github.com/spf13/viper/issues/1014
	secrets := make(SecretsConfig, len(c.EdgeRuntime.Secrets))
	for k, v := range c.EdgeRuntime.Secrets {
		secrets[strings.ToUpper(k)] = v
	}
	c.EdgeRuntime.Secrets = secrets
	return nil
}

func (c *config) newDecodeHook(fs ...mapstructure.DecodeHookFunc) mapstructure.DecodeHookFunc {
	fs = append(fs,
		mapstructure.StringToTimeDurationHookFunc(),
		mapstructure.StringToIPHookFunc(),
		mapstructure.StringToSliceHookFunc(","),
		mapstructure.TextUnmarshallerHookFunc(),
		DecryptSecretHookFunc(c.ProjectId),
	)
	return mapstructure.ComposeDecodeHookFunc(fs...)
}

func (c *config) Load(path string, fsys fs.FS) error {
	builder := NewPathBuilder(path)
	// Load secrets from .env file
	if err := loadNestedEnv(builder.SupabaseDirPath); err != nil {
		return err
	}
	if err := c.loadFromFile(builder.ConfigPath, fsys); err != nil {
		return err
	}
	// Generate JWT tokens
	if len(c.Auth.AnonKey.Value) == 0 {
		anonToken := CustomClaims{Role: "anon"}.NewToken()
		if signed, err := anonToken.SignedString([]byte(c.Auth.JwtSecret.Value)); err != nil {
			return errors.Errorf("failed to generate anon key: %w", err)
		} else {
			c.Auth.AnonKey.Value = signed
		}
	}
	if len(c.Auth.ServiceRoleKey.Value) == 0 {
		anonToken := CustomClaims{Role: "service_role"}.NewToken()
		if signed, err := anonToken.SignedString([]byte(c.Auth.JwtSecret.Value)); err != nil {
			return errors.Errorf("failed to generate service_role key: %w", err)
		} else {
			c.Auth.ServiceRoleKey.Value = signed
		}
	}
	// TODO: move linked pooler connection string elsewhere
	if connString, err := fs.ReadFile(fsys, builder.PoolerUrlPath); err == nil && len(connString) > 0 {
		c.Db.Pooler.ConnectionString = string(connString)
	}
	if len(c.Api.ExternalUrl) == 0 {
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
	}
	// Update image versions
	switch c.Db.MajorVersion {
	case 13:
		c.Db.Image = pg15
	case 14:
		c.Db.Image = pg14
	case 15:
		c.Db.Image = pg15
	}
	if c.Db.MajorVersion > 14 {
		if version, err := fs.ReadFile(fsys, builder.PostgresVersionPath); err == nil {
			// Only replace image if postgres version is above 15.1.0.55
			if i := strings.IndexByte(c.Db.Image, ':'); VersionCompare(c.Db.Image[i+1:], "15.1.0.55") >= 0 {
				c.Db.Image = replaceImageTag(Images.Pg, string(version))
			}
		}
		if version, err := fs.ReadFile(fsys, builder.RestVersionPath); err == nil && len(version) > 0 {
			c.Api.Image = replaceImageTag(Images.Postgrest, string(version))
		}
		if version, err := fs.ReadFile(fsys, builder.GotrueVersionPath); err == nil && len(version) > 0 {
			c.Auth.Image = replaceImageTag(Images.Gotrue, string(version))
		}
	}
	if version, err := fs.ReadFile(fsys, builder.StorageVersionPath); err == nil && len(version) > 0 {
		// For backwards compatibility, exclude all strings that look like semver
		if v := strings.TrimSpace(string(version)); !semver.IsValid(v) {
			c.Storage.TargetMigration = v
		}
	}
	if version, err := fs.ReadFile(fsys, builder.EdgeRuntimeVersionPath); err == nil && len(version) > 0 {
		c.EdgeRuntime.Image = replaceImageTag(Images.EdgeRuntime, string(version))
	}
	if version, err := fs.ReadFile(fsys, builder.PoolerVersionPath); err == nil && len(version) > 0 {
		c.Db.Pooler.Image = replaceImageTag(Images.Supavisor, string(version))
	}
	if version, err := fs.ReadFile(fsys, builder.RealtimeVersionPath); err == nil && len(version) > 0 {
		c.Realtime.Image = replaceImageTag(Images.Realtime, string(version))
	}
	if version, err := fs.ReadFile(fsys, builder.StudioVersionPath); err == nil && len(version) > 0 {
		c.Studio.Image = replaceImageTag(Images.Studio, string(version))
	}
	if version, err := fs.ReadFile(fsys, builder.PgmetaVersionPath); err == nil && len(version) > 0 {
		c.Studio.PgmetaImage = replaceImageTag(Images.Pgmeta, string(version))
	}
	// TODO: replace derived config resolution with viper decode hooks
	if err := c.resolve(builder, fsys); err != nil {
		return err
	}
	return c.Validate(fsys)
}

func VersionCompare(a, b string) int {
	var pA, pB string
	if vA := strings.Split(a, "."); len(vA) > 3 {
		a = strings.Join(vA[:3], ".")
		pA = strings.TrimLeft(strings.Join(vA[3:], "."), "0")
	}
	if vB := strings.Split(b, "."); len(vB) > 3 {
		b = strings.Join(vB[:3], ".")
		pB = strings.TrimLeft(strings.Join(vB[3:], "."), "0")
	}
	if r := semver.Compare("v"+a, "v"+b); r != 0 {
		return r
	}
	return semver.Compare("v"+pA, "v"+pB)
}

func (c *baseConfig) resolve(builder pathBuilder, fsys fs.FS) error {
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
		for i, val := range function.StaticFiles {
			if len(val) > 0 && !filepath.IsAbs(val) {
				function.StaticFiles[i] = filepath.Join(builder.SupabaseDirPath, val)
			}
		}
		c.Functions[slug] = function
	}
	if c.Db.Seed.Enabled {
		for i, pattern := range c.Db.Seed.SqlPaths {
			if len(pattern) > 0 && !filepath.IsAbs(pattern) {
				c.Db.Seed.SqlPaths[i] = path.Join(builder.SupabaseDirPath, pattern)
			}
		}
	}
	for i, pattern := range c.Db.Migrations.SchemaPaths {
		if len(pattern) > 0 && !filepath.IsAbs(pattern) {
			c.Db.Migrations.SchemaPaths[i] = path.Join(builder.SupabaseDirPath, pattern)
		}
	}
	return nil
}

func (c *config) Validate(fsys fs.FS) error {
	if c.ProjectId == "" {
		return errors.New("Missing required field in config: project_id")
	} else if sanitized := sanitizeProjectId(c.ProjectId); sanitized != c.ProjectId {
		fmt.Fprintln(os.Stderr, "WARN: project_id field in config is invalid. Auto-fixing to", sanitized)
		c.ProjectId = sanitized
	}
	// Since remote config is merged to base, we only need to validate the project_id field.
	for name, remote := range c.Remotes {
		if !refPattern.MatchString(remote.ProjectId) {
			return errors.Errorf("Invalid config for remotes.%s.project_id. Must be like: abcdefghijklmnopqrst", name)
		}
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
	case 13, 14, 17:
		// TODO: support oriole db 17 eventually
	case 15:
		if len(c.Experimental.OrioleDBVersion) > 0 {
			c.Db.Image = "supabase/postgres:orioledb-" + c.Experimental.OrioleDBVersion
			if err := assertEnvLoaded(c.Experimental.S3Host); err != nil {
				return err
			}
			if err := assertEnvLoaded(c.Experimental.S3Region); err != nil {
				return err
			}
			if err := assertEnvLoaded(c.Experimental.S3AccessKey); err != nil {
				return err
			}
			if err := assertEnvLoaded(c.Experimental.S3SecretKey); err != nil {
				return err
			}
		}
	default:
		return errors.Errorf("Failed reading config: Invalid %s: %v.", "db.major_version", c.Db.MajorVersion)
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
		if err := assertEnvLoaded(c.Auth.SiteUrl); err != nil {
			return err
		}
		for i, url := range c.Auth.AdditionalRedirectUrls {
			if err := assertEnvLoaded(url); err != nil {
				return errors.Errorf("Invalid config for auth.additional_redirect_urls[%d]: %v", i, err)
			}
		}
		if c.Auth.Captcha != nil && c.Auth.Captcha.Enabled {
			if len(c.Auth.Captcha.Provider) == 0 {
				return errors.New("Missing required field in config: auth.captcha.provider")
			}
			if len(c.Auth.Captcha.Secret.Value) == 0 {
				return errors.Errorf("Missing required field in config: auth.captcha.secret")
			}
			if err := assertEnvLoaded(c.Auth.Captcha.Secret.Value); err != nil {
				return err
			}
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
	for name := range c.Functions {
		if err := ValidateFunctionSlug(name); err != nil {
			return err
		}
	}
	switch c.EdgeRuntime.DenoVersion {
	case 0:
		return errors.New("Missing required field in config: edge_runtime.deno_version")
	case 1:
		break
	case 2:
		c.EdgeRuntime.Image = deno2
	default:
		return errors.Errorf("Failed reading config: Invalid %s: %v.", "edge_runtime.deno_version", c.EdgeRuntime.DenoVersion)
	}
	// Validate logflare config
	if c.Analytics.Enabled {
		if c.Analytics.Backend == LogflareBigQuery {
			if len(c.Analytics.GcpProjectId) == 0 {
				return errors.New("Missing required field in config: analytics.gcp_project_id")
			}
			if len(c.Analytics.GcpProjectNumber) == 0 {
				return errors.New("Missing required field in config: analytics.gcp_project_number")
			}
			if len(c.Analytics.GcpJwtPath) == 0 {
				return errors.New("Path to GCP Service Account Key must be provided in config, relative to config.toml: analytics.gcp_jwt_path")
			}
		}
	}
	if err := c.Experimental.validate(); err != nil {
		return err
	}
	return nil
}

func assertEnvLoaded(s string) error {
	if matches := envPattern.FindStringSubmatch(s); len(matches) > 1 {
		fmt.Fprintln(os.Stderr, "WARN: environment variable is unset:", matches[1])
	}
	return nil
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

func loadNestedEnv(basePath string) error {
	repoDir, err := os.Getwd()
	if err != nil {
		return errors.Errorf("failed to get repo directory: %w", err)
	}
	if !filepath.IsAbs(basePath) {
		basePath = filepath.Join(repoDir, basePath)
	}
	env := os.Getenv("SUPABASE_ENV")
	for cwd := basePath; cwd != filepath.Dir(repoDir); cwd = filepath.Dir(cwd) {
		if err := os.Chdir(cwd); err != nil && !errors.Is(err, os.ErrNotExist) {
			return errors.Errorf("failed to change directory: %w", err)
		}
		if err := loadDefaultEnv(env); err != nil {
			return err
		}
	}
	if err := os.Chdir(repoDir); err != nil {
		return errors.Errorf("failed to restore directory: %w", err)
	}
	return nil
}

func loadDefaultEnv(env string) error {
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
		// If DEBUG=1, return the error as is for full debugability
		if viper.GetBool("DEBUG") {
			return errors.Errorf("failed to load %s: %w", path, err)
		}
		msg := err.Error()
		switch {
		case strings.HasPrefix(msg, "unexpected character"):
			// Try to extract the character, fallback to generic
			start := strings.Index(msg, "unexpected character \"")
			if start != -1 {
				start += len("unexpected character \"")
				end := strings.Index(msg[start:], "\"")
				if end != -1 {
					char := msg[start : start+end]
					return errors.Errorf("failed to parse environment file: %s (unexpected character '%s' in variable name)", path, char)
				}
			}
			return errors.Errorf("failed to parse environment file: %s (unexpected character in variable name)", path)
		case strings.HasPrefix(msg, "unterminated quoted value"):
			return errors.Errorf("failed to parse environment file: %s (unterminated quoted value)", path)
		// If the error message contains newlines, there is a high chance that the actual content of the
		// dotenv file is being leaked. In such cases, we return a generic error to avoid unwanted leaks in the logs
		case strings.Contains(msg, "\n"):
			return errors.Errorf("failed to parse environment file: %s (syntax error)", path)
		default:
			return errors.Errorf("failed to load %s: %w", path, err)
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
	if e.Smtp != nil && e.Smtp.Enabled {
		if len(e.Smtp.Host) == 0 {
			return errors.New("Missing required field in config: auth.email.smtp.host")
		}
		if e.Smtp.Port == 0 {
			return errors.New("Missing required field in config: auth.email.smtp.port")
		}
		if len(e.Smtp.User) == 0 {
			return errors.New("Missing required field in config: auth.email.smtp.user")
		}
		if len(e.Smtp.Pass.Value) == 0 {
			return errors.New("Missing required field in config: auth.email.smtp.pass")
		}
		if len(e.Smtp.AdminEmail) == 0 {
			return errors.New("Missing required field in config: auth.email.smtp.admin_email")
		}
		if err := assertEnvLoaded(e.Smtp.Pass.Value); err != nil {
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
		if len(s.Twilio.AuthToken.Value) == 0 {
			return errors.New("Missing required field in config: auth.sms.twilio.auth_token")
		}
		if err := assertEnvLoaded(s.Twilio.AuthToken.Value); err != nil {
			return err
		}
	case s.TwilioVerify.Enabled:
		if len(s.TwilioVerify.AccountSid) == 0 {
			return errors.New("Missing required field in config: auth.sms.twilio_verify.account_sid")
		}
		if len(s.TwilioVerify.MessageServiceSid) == 0 {
			return errors.New("Missing required field in config: auth.sms.twilio_verify.message_service_sid")
		}
		if len(s.TwilioVerify.AuthToken.Value) == 0 {
			return errors.New("Missing required field in config: auth.sms.twilio_verify.auth_token")
		}
		if err := assertEnvLoaded(s.TwilioVerify.AuthToken.Value); err != nil {
			return err
		}
	case s.Messagebird.Enabled:
		if len(s.Messagebird.Originator) == 0 {
			return errors.New("Missing required field in config: auth.sms.messagebird.originator")
		}
		if len(s.Messagebird.AccessKey.Value) == 0 {
			return errors.New("Missing required field in config: auth.sms.messagebird.access_key")
		}
		if err := assertEnvLoaded(s.Messagebird.AccessKey.Value); err != nil {
			return err
		}
	case s.Textlocal.Enabled:
		if len(s.Textlocal.Sender) == 0 {
			return errors.New("Missing required field in config: auth.sms.textlocal.sender")
		}
		if len(s.Textlocal.ApiKey.Value) == 0 {
			return errors.New("Missing required field in config: auth.sms.textlocal.api_key")
		}
		if err := assertEnvLoaded(s.Textlocal.ApiKey.Value); err != nil {
			return err
		}
	case s.Vonage.Enabled:
		if len(s.Vonage.From) == 0 {
			return errors.New("Missing required field in config: auth.sms.vonage.from")
		}
		if len(s.Vonage.ApiKey) == 0 {
			return errors.New("Missing required field in config: auth.sms.vonage.api_key")
		}
		if len(s.Vonage.ApiSecret.Value) == 0 {
			return errors.New("Missing required field in config: auth.sms.vonage.api_secret")
		}
		if err := assertEnvLoaded(s.Vonage.ApiKey); err != nil {
			return err
		}
		if err := assertEnvLoaded(s.Vonage.ApiSecret.Value); err != nil {
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
		if !sliceContains([]string{"apple", "google"}, ext) && len(provider.Secret.Value) == 0 {
			return errors.Errorf("Missing required field in config: auth.external.%s.secret", ext)
		}
		if err := assertEnvLoaded(provider.ClientId); err != nil {
			return err
		}
		if err := assertEnvLoaded(provider.Secret.Value); err != nil {
			return err
		}
		if err := assertEnvLoaded(provider.RedirectUri); err != nil {
			return err
		}
		if err := assertEnvLoaded(provider.Url); err != nil {
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
	if hook := h.BeforeUserCreated; hook != nil {
		if err := hook.validate("before_user_created"); err != nil {
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
		if len(h.Secrets.Value) == 0 {
			return errors.Errorf("Missing required field in config: auth.hook.%s.secrets", hookType)
		} else if err := assertEnvLoaded(h.Secrets.Value); err != nil {
			return err
		}
		for _, secret := range strings.Split(h.Secrets.Value, "|") {
			if !hookSecretPattern.MatchString(secret) {
				return errors.Errorf(`Invalid hook config: auth.hook.%s.secrets must be formatted as "v1,whsec_<base64_encoded_secret>" with a minimum length of 32 characters.`, hookType)
			}
		}
	case "pg-functions":
		if len(h.Secrets.Value) > 0 {
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
	} else if err := assertEnvLoaded(c.UserPoolID); err != nil {
		return err
	}

	if c.UserPoolRegion == "" {
		return errors.New("Invalid config: auth.third_party.cognito is enabled but without a user_pool_region.")
	} else if err := assertEnvLoaded(c.UserPoolRegion); err != nil {
		return err
	}

	return nil
}

var clerkDomainPattern = regexp.MustCompile("^(clerk([.][a-z0-9-]+){2,}|([a-z0-9-]+[.])+clerk[.]accounts[.]dev)$")

func (c *tpaClerk) issuerURL() string {
	return fmt.Sprintf("https://%s", c.Domain)
}

func (c *tpaClerk) validate() (err error) {
	if c.Domain == "" {
		return errors.New("Invalid config: auth.third_party.clerk is enabled but without a domain.")
	} else if err := assertEnvLoaded(c.Domain); err != nil {
		return err
	}

	if !clerkDomainPattern.MatchString(c.Domain) {
		return errors.New("Invalid config: auth.third_party.clerk has invalid domain, it usually is like clerk.example.com or example.clerk.accounts.dev. Check https://clerk.com/setup/supabase on how to find the correct value.")
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

	if tpa.Clerk.Enabled {
		enabled += 1

		if err := tpa.Clerk.validate(); err != nil {
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

	if tpa.Clerk.Enabled {
		return tpa.Clerk.issuerURL()
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
	secretJWK.KeyBase64URL = base64.RawURLEncoding.EncodeToString([]byte(a.JwtSecret.Value))

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
// Pre: config must be loaded after setting config.ProjectID = "ref"
func (c *config) GetRemoteByProjectRef(projectRef string) (baseConfig, error) {
	base := c.Clone()
	for _, remote := range c.Remotes {
		if remote.ProjectId == projectRef {
			base.ProjectId = projectRef
			return base, nil
		}
	}
	return base, errors.Errorf("no remote found for project_id: %s", projectRef)
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
