package utils

import (
	_ "embed"
	"testing"
	"text/template"

	"github.com/BurntSushi/toml"
	"github.com/spf13/afero"
	"github.com/stretchr/testify/assert"
)

var (
	//go:embed templates/init_config.test.toml
	testInitConfigEmbed    string
	testInitConfigTemplate = template.Must(template.New("initConfig.test").Parse(testInitConfigEmbed))
)

func TestConfigParsing(t *testing.T) {
	// Reset global variable
	copy := initConfigTemplate
	teardown := func() {
		initConfigTemplate = copy
	}

	t.Run("classic config file", func(t *testing.T) {
		defer teardown()
		fsys := afero.NewMemMapFs()
		assert.NoError(t, WriteConfig(fsys, false))
		assert.NoError(t, LoadConfigFS(fsys))
	})

	t.Run("config file with environment variables", func(t *testing.T) {
		defer teardown()
		initConfigTemplate = testInitConfigTemplate
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		assert.NoError(t, afero.WriteFile(fsys, "supabase/templates/invite.html", nil, 0644))
		assert.NoError(t, WriteConfig(fsys, true))
		// Run test
		t.Setenv("TWILIO_AUTH_TOKEN", "token")
		t.Setenv("AZURE_CLIENT_ID", "hello")
		t.Setenv("AZURE_SECRET", "this is cool")
		assert.NoError(t, LoadConfigFS(fsys))
		// Check error
		assert.Equal(t, "hello", Config.Auth.External["azure"].ClientId)
		assert.Equal(t, "this is cool", Config.Auth.External["azure"].Secret)
	})

	t.Run("config file with environment variables fails when unset", func(t *testing.T) {
		defer teardown()
		initConfigTemplate = testInitConfigTemplate
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		assert.NoError(t, WriteConfig(fsys, true))
		// Run test
		assert.Error(t, LoadConfigFS(fsys))
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
}
