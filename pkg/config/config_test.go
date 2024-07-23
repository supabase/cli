package config

import (
	"bytes"
	_ "embed"
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
		assert.NoError(t, config.Load("", fsys))
		// Check error
		assert.Equal(t, "hello", config.Auth.External["azure"].ClientId)
		assert.Equal(t, "this is cool", config.Auth.External["azure"].Secret)
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
		name      string
		uri       string
		hookName  string
		shouldErr bool
		errorMsg  string
	}{
		{
			name:      "valid http URL",
			uri:       "http://example.com",
			hookName:  "testHook",
			shouldErr: false,
		},
		{
			name:      "valid https URL",
			uri:       "https://example.com",
			hookName:  "testHook",
			shouldErr: false,
		},
		{
			name:      "valid pg-functions URI",
			uri:       "pg-functions://functionName",
			hookName:  "pgHook",
			shouldErr: false,
		},
		{
			name:      "invalid URI with unsupported scheme",
			uri:       "ftp://example.com",
			hookName:  "malformedHook",
			shouldErr: true,
			errorMsg:  "Invalid HTTP hook config: auth.hook.malformedHook should be a Postgres function URI, or a HTTP or HTTPS URL",
		},
		{
			name:      "invalid URI with parsing error",
			uri:       "http://a b.com",
			hookName:  "errorHook",
			shouldErr: true,
			errorMsg:  "failed to parse template url: parse \"http://a b.com\": invalid character \" \" in host name",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := validateHookURI(tt.uri, tt.hookName)
			if tt.shouldErr {
				assert.Error(t, err, "Expected an error for %v", tt.name)
				assert.EqualError(t, err, tt.errorMsg, "Expected error message does not match for %v", tt.name)
			} else {
				assert.NoError(t, err, "Expected no error for %v", tt.name)
			}
		})
	}
}
