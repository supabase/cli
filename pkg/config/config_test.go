package config

import (
	"bytes"
	_ "embed"
	"path"
	"strings"
	"testing"
	fs "testing/fstest"

	"github.com/BurntSushi/toml"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

//go:embed testdata/config.toml
var testInitConfigEmbed []byte

func TestConfigParsing(t *testing.T) {
	t.Run("classic config file", func(t *testing.T) {
		config := NewConfig()
		// Run test
		var buf bytes.Buffer
		require.NoError(t, config.Eject(&buf))
		file := fs.MapFile{Data: buf.Bytes()}
		fsys := fs.MapFS{"config.toml": &file}
		// Check error
		assert.NoError(t, config.Load("config.toml", fsys))
	})

	t.Run("config file with environment variables", func(t *testing.T) {
		config := NewConfig()
		// Setup in-memory fs
		fsys := fs.MapFS{
			"supabase/config.toml":           &fs.MapFile{Data: testInitConfigEmbed},
			"supabase/templates/invite.html": &fs.MapFile{},
		}
		// Run test
		t.Setenv("TWILIO_AUTH_TOKEN", "token")
		t.Setenv("AZURE_CLIENT_ID", "hello")
		t.Setenv("AZURE_SECRET", "this is cool")
		t.Setenv("AUTH_SEND_SMS_SECRETS", "v1,whsec_aWxpa2VzdXBhYmFzZXZlcnltdWNoYW5kaWhvcGV5b3Vkb3Rvbw==")
		t.Setenv("SENDGRID_API_KEY", "sendgrid")
		t.Setenv("AUTH_CALLBACK_URL", "http://localhost:3000/auth/callback")
		assert.NoError(t, config.Load("", fsys))
		// Check error
		assert.Equal(t, "hello", config.Auth.External["azure"].ClientId)
		assert.Equal(t, "this is cool", config.Auth.External["azure"].Secret)
		assert.Equal(t, []string{
			"https://127.0.0.1:3000",
			"http://localhost:3000/auth/callback",
		}, config.Auth.AdditionalRedirectUrls)
	})

	t.Run("config file with environment variables fails when unset", func(t *testing.T) {
		config := NewConfig()
		// Setup in-memory fs
		fsys := fs.MapFS{
			"supabase/config.toml": &fs.MapFile{Data: testInitConfigEmbed},
		}
		// Run test
		assert.Error(t, config.Load("", fsys))
	})

	t.Run("config file with remotes", func(t *testing.T) {
		config := NewConfig()
		// Setup in-memory fs
		fsys := fs.MapFS{
			"supabase/config.toml":           &fs.MapFile{Data: testInitConfigEmbed},
			"supabase/templates/invite.html": &fs.MapFile{},
		}
		// Run test
		t.Setenv("TWILIO_AUTH_TOKEN", "token")
		t.Setenv("AZURE_CLIENT_ID", "hello")
		t.Setenv("AZURE_SECRET", "this is cool")
		t.Setenv("AUTH_SEND_SMS_SECRETS", "v1,whsec_aWxpa2VzdXBhYmFzZXZlcnltdWNoYW5kaWhvcGV5b3Vkb3Rvbw==")
		t.Setenv("SENDGRID_API_KEY", "sendgrid")
		t.Setenv("AUTH_CALLBACK_URL", "http://localhost:3000/auth/callback")
		assert.NoError(t, config.Load("", fsys))
		// Check the default value in the config
		assert.Equal(t, "http://127.0.0.1:3000", config.Auth.SiteUrl)
		assert.Equal(t, true, config.Auth.EnableSignup)
		assert.Equal(t, true, config.Auth.External["azure"].Enabled)
		assert.Equal(t, []string{"image/png", "image/jpeg"}, config.Storage.Buckets["images"].AllowedMimeTypes)
		// Check the values for remotes override
		production, ok := config.Remotes["production"]
		assert.True(t, ok)
		staging, ok := config.Remotes["staging"]
		assert.True(t, ok)
		// Check the values for production override
		assert.Equal(t, config.ProjectId, production.ProjectId)
		assert.Equal(t, "http://feature-auth-branch.com/", production.Auth.SiteUrl)
		assert.Equal(t, false, production.Auth.EnableSignup)
		assert.Equal(t, false, production.Auth.External["azure"].Enabled)
		assert.Equal(t, "nope", production.Auth.External["azure"].ClientId)
		// Check seed should be disabled by default for remote configs
		assert.Equal(t, false, production.Db.Seed.Enabled)
		// Check the values for the staging override
		assert.Equal(t, "staging-project", staging.ProjectId)
		assert.Equal(t, []string{"image/png"}, staging.Storage.Buckets["images"].AllowedMimeTypes)
		assert.Equal(t, true, staging.Db.Seed.Enabled)
	})
}

func TestFileSizeLimitConfigParsing(t *testing.T) {
	t.Run("test file size limit parsing number", func(t *testing.T) {
		var testConfig config
		_, err := toml.Decode(`
		[storage]
		file_size_limit = 5000000
		`, &testConfig)
		if assert.NoError(t, err) {
			assert.Equal(t, sizeInBytes(5000000), testConfig.Storage.FileSizeLimit)
		}
	})

	t.Run("test file size limit parsing bytes unit", func(t *testing.T) {
		var testConfig config
		_, err := toml.Decode(`
		[storage]
		file_size_limit = "5MB"
		`, &testConfig)
		if assert.NoError(t, err) {
			assert.Equal(t, sizeInBytes(5242880), testConfig.Storage.FileSizeLimit)
		}
	})

	t.Run("test file size limit parsing binary bytes unit", func(t *testing.T) {
		var testConfig config
		_, err := toml.Decode(`
		[storage]
		file_size_limit = "5MiB"
		`, &testConfig)
		if assert.NoError(t, err) {
			assert.Equal(t, sizeInBytes(5242880), testConfig.Storage.FileSizeLimit)
		}
	})

	t.Run("test file size limit parsing string number", func(t *testing.T) {
		var testConfig config
		_, err := toml.Decode(`
		[storage]
		file_size_limit = "5000000"
		`, &testConfig)
		if assert.NoError(t, err) {
			assert.Equal(t, sizeInBytes(5000000), testConfig.Storage.FileSizeLimit)
		}
	})

	t.Run("test file size limit parsing bad datatype", func(t *testing.T) {
		var testConfig config
		_, err := toml.Decode(`
		[storage]
		file_size_limit = []
		`, &testConfig)
		assert.Error(t, err)
		assert.Equal(t, sizeInBytes(0), testConfig.Storage.FileSizeLimit)
	})

	t.Run("test file size limit parsing bad string data", func(t *testing.T) {
		var testConfig config
		_, err := toml.Decode(`
		[storage]
		file_size_limit = "foobar"
		`, &testConfig)
		assert.Error(t, err)
		assert.Equal(t, sizeInBytes(0), testConfig.Storage.FileSizeLimit)
	})
}

func TestSanitizeProjectI(t *testing.T) {
	// Preserves valid consecutive characters
	assert.Equal(t, "abc", sanitizeProjectId("abc"))
	assert.Equal(t, "a..b_c", sanitizeProjectId("a..b_c"))
	// Removes leading special characters
	assert.Equal(t, "abc", sanitizeProjectId("_abc"))
	assert.Equal(t, "abc", sanitizeProjectId("_@abc"))
	// Replaces consecutive invalid characters with a single _
	assert.Equal(t, "a_bc-", sanitizeProjectId("a@@bc-"))
	// Truncates to less than 40 characters
	sanitized := strings.Repeat("a", maxProjectIdLength)
	assert.Equal(t, sanitized, sanitizeProjectId(sanitized+"bb"))
}

const (
	defaultAnonKey        = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0"
	defaultServiceRoleKey = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU"
)

func TestSigningJWT(t *testing.T) {
	t.Run("signs default anon key", func(t *testing.T) {
		anonToken := CustomClaims{Role: "anon"}.NewToken()
		signed, err := anonToken.SignedString([]byte(defaultJwtSecret))
		assert.NoError(t, err)
		assert.Equal(t, defaultAnonKey, signed)
	})

	t.Run("signs default service_role key", func(t *testing.T) {
		serviceToken := CustomClaims{Role: "service_role"}.NewToken()
		signed, err := serviceToken.SignedString([]byte(defaultJwtSecret))
		assert.NoError(t, err)
		assert.Equal(t, defaultServiceRoleKey, signed)
	})
}

func TestValidateHookURI(t *testing.T) {
	tests := []struct {
		hookConfig
		name     string
		errorMsg string
	}{
		{
			name: "valid http URL",
			hookConfig: hookConfig{
				Enabled: true,
				URI:     "http://example.com",
				Secrets: "v1,whsec_aWxpa2VzdXBhYmFzZXZlcnltdWNoYW5kaWhvcGV5b3Vkb3Rvbw==",
			},
		},
		{
			name: "valid https URL",
			hookConfig: hookConfig{
				Enabled: true,
				URI:     "https://example.com",
				Secrets: "v1,whsec_aWxpa2VzdXBhYmFzZXZlcnltdWNoYW5kaWhvcGV5b3Vkb3Rvbw==",
			},
		},
		{
			name: "valid pg-functions URI",
			hookConfig: hookConfig{
				Enabled: true,
				URI:     "pg-functions://functionName",
			},
		},
		{
			name: "invalid URI with unsupported scheme",
			hookConfig: hookConfig{
				Enabled: true,
				URI:     "ftp://example.com",
				Secrets: "v1,whsec_aWxpa2VzdXBhYmFzZXZlcnltdWNoYW5kaWhvcGV5b3Vkb3Rvbw==",
			},
			errorMsg: "Invalid hook config: auth.hook.invalid URI with unsupported scheme.uri should be a HTTP, HTTPS, or pg-functions URI",
		},
		{
			name: "invalid URI with parsing error",
			hookConfig: hookConfig{
				Enabled: true,
				URI:     "http://a b.com",
				Secrets: "v1,whsec_aWxpa2VzdXBhYmFzZXZlcnltdWNoYW5kaWhvcGV5b3Vkb3Rvbw==",
			},
			errorMsg: "failed to parse template url: parse \"http://a b.com\": invalid character \" \" in host name",
		},
		{
			name: "valid http URL with missing secrets",
			hookConfig: hookConfig{
				Enabled: true,
				URI:     "http://example.com",
			},
			errorMsg: "Missing required field in config: auth.hook.valid http URL with missing secrets.secrets",
		},
		{
			name: "valid pg-functions URI with unsupported secrets",
			hookConfig: hookConfig{
				Enabled: true,
				URI:     "pg-functions://functionName",
				Secrets: "test-secret",
			},
			errorMsg: "Invalid hook config: auth.hook.valid pg-functions URI with unsupported secrets.secrets is unsupported for pg-functions URI",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := tt.hookConfig.validate(tt.name)
			if len(tt.errorMsg) > 0 {
				assert.Error(t, err, "Expected an error for %v", tt.name)
				assert.EqualError(t, err, tt.errorMsg, "Expected error message does not match for %v", tt.name)
			} else {
				assert.NoError(t, err, "Expected no error for %v", tt.name)
			}
		})
	}
}

func TestLoadSeedPaths(t *testing.T) {
	t.Run("returns seed files matching patterns", func(t *testing.T) {
		// Setup in-memory fs
		fsys := fs.MapFS{
			"supabase/seeds/seed1.sql":   &fs.MapFile{Data: []byte("INSERT INTO table1 VALUES (1);")},
			"supabase/seeds/seed2.sql":   &fs.MapFile{Data: []byte("INSERT INTO table2 VALUES (2);")},
			"supabase/seeds/seed3.sql":   &fs.MapFile{Data: []byte("INSERT INTO table2 VALUES (2);")},
			"supabase/seeds/another.sql": &fs.MapFile{Data: []byte("INSERT INTO table2 VALUES (2);")},
			"supabase/seeds/ignore.sql":  &fs.MapFile{Data: []byte("INSERT INTO table3 VALUES (3);")},
		}
		// Mock config patterns
		config := seed{
			Enabled: true,
			GlobPatterns: []string{
				"seeds/seed[12].sql",
				"seeds/ano*.sql",
			},
		}
		// Run test
		err := config.loadSeedPaths("supabase", fsys)
		// Check error
		assert.NoError(t, err)
		// Validate files
		assert.ElementsMatch(t, []string{
			"supabase/seeds/seed1.sql",
			"supabase/seeds/seed2.sql",
			"supabase/seeds/another.sql",
		}, config.SqlPaths)
	})
	t.Run("returns seed files matching patterns skip duplicates", func(t *testing.T) {
		// Setup in-memory fs
		fsys := fs.MapFS{
			"supabase/seeds/seed1.sql":   &fs.MapFile{Data: []byte("INSERT INTO table1 VALUES (1);")},
			"supabase/seeds/seed2.sql":   &fs.MapFile{Data: []byte("INSERT INTO table2 VALUES (2);")},
			"supabase/seeds/seed3.sql":   &fs.MapFile{Data: []byte("INSERT INTO table2 VALUES (2);")},
			"supabase/seeds/another.sql": &fs.MapFile{Data: []byte("INSERT INTO table2 VALUES (2);")},
			"supabase/seeds/ignore.sql":  &fs.MapFile{Data: []byte("INSERT INTO table3 VALUES (3);")},
		}
		// Mock config patterns
		config := seed{
			Enabled: true,
			GlobPatterns: []string{
				"seeds/seed[12].sql",
				"seeds/ano*.sql",
				"seeds/seed*.sql",
			},
		}
		// Run test
		err := config.loadSeedPaths("supabase", fsys)
		// Check error
		assert.NoError(t, err)
		// Validate files
		assert.ElementsMatch(t, []string{
			"supabase/seeds/seed1.sql",
			"supabase/seeds/seed2.sql",
			"supabase/seeds/another.sql",
			"supabase/seeds/seed3.sql",
		}, config.SqlPaths)
	})

	t.Run("returns error on invalid pattern", func(t *testing.T) {
		// Setup in-memory fs
		fsys := fs.MapFS{}
		// Mock config patterns
		config := seed{Enabled: true, GlobPatterns: []string{"[*!#@D#"}}
		// Run test
		err := config.loadSeedPaths("", fsys)
		// Check error
		assert.ErrorIs(t, err, path.ErrBadPattern)
		// The resuling seed list should be empty
		assert.Empty(t, config.SqlPaths)
	})

	t.Run("returns empty list if no files match", func(t *testing.T) {
		// Setup in-memory fs
		fsys := fs.MapFS{}
		// Mock config patterns
		config := seed{Enabled: true, GlobPatterns: []string{"seeds/*.sql"}}
		// Run test
		err := config.loadSeedPaths("", fsys)
		// Check error
		assert.NoError(t, err)
		// Validate files
		assert.Empty(t, config.SqlPaths)
	})
}

func TestLoadEnv(t *testing.T) {
	t.Setenv("SUPABASE_AUTH_JWT_SECRET", "test-secret")
	t.Setenv("SUPABASE_DB_ROOT_KEY", "test-root-key")
	config := NewConfig()
	// Run test
	err := config.loadFromEnv()
	// Check error
	assert.NoError(t, err)
	assert.Equal(t, "test-secret", config.Auth.JwtSecret)
	assert.Equal(t, "test-root-key", config.Db.RootKey)
}

func TestLoadFunctionImportMap(t *testing.T) {
	t.Run("uses deno.json as import map when present", func(t *testing.T) {
		config := NewConfig()
		fsys := fs.MapFS{
			"supabase/config.toml": &fs.MapFile{Data: []byte(`
			project_id = "test"
			[functions.hello]
			`)},
			"supabase/functions/hello/deno.json": &fs.MapFile{},
			"supabase/functions/hello/index.ts":  &fs.MapFile{},
		}
		// Run test
		assert.NoError(t, config.Load("", fsys))
		// Check that deno.json was set as import map
		assert.Equal(t, "supabase/functions/hello/deno.json", config.Functions["hello"].ImportMap)
	})

	t.Run("uses deno.jsonc as import map when present", func(t *testing.T) {
		config := NewConfig()
		fsys := fs.MapFS{
			"supabase/config.toml": &fs.MapFile{Data: []byte(`
			project_id = "test"
			[functions.hello]
			`)},
			"supabase/functions/hello/deno.jsonc": &fs.MapFile{},
			"supabase/functions/hello/index.ts":   &fs.MapFile{},
		}
		// Run test
		assert.NoError(t, config.Load("", fsys))
		// Check that deno.json was set as import map
		assert.Equal(t, "supabase/functions/hello/deno.jsonc", config.Functions["hello"].ImportMap)
	})

	t.Run("config.toml takes precedence over deno.json", func(t *testing.T) {
		config := NewConfig()
		fsys := fs.MapFS{
			"supabase/config.toml": &fs.MapFile{Data: []byte(`
			project_id = "test"
			[functions]
			hello.import_map = "custom_import_map.json"
			`)},
			"supabase/functions/hello/deno.json": &fs.MapFile{},
			"supabase/functions/hello/index.ts":  &fs.MapFile{},
		}
		// Run test
		assert.NoError(t, config.Load("", fsys))
		// Check that config.toml takes precedence over deno.json
		assert.Equal(t, "supabase/custom_import_map.json", config.Functions["hello"].ImportMap)
	})
}
