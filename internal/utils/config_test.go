package utils

import (
	"testing"

	"github.com/BurntSushi/toml"
	"github.com/spf13/afero"
	"github.com/stretchr/testify/assert"
)

func TestConfigParsing(t *testing.T) {
	t.Run("classic config file", func(t *testing.T) {
		fsys := afero.NewMemMapFs()
		assert.NoError(t, WriteConfig(fsys, false))
		assert.NoError(t, LoadConfigFS(fsys))
	})

	t.Run("config file with environment variables", func(t *testing.T) {
		fsys := afero.NewMemMapFs()
		assert.NoError(t, WriteConfig(fsys, true))

		t.Setenv("AZURE_CLIENT_ID", "hello")
		t.Setenv("AZURE_SECRET", "this is cool")
		assert.NoError(t, LoadConfigFS(fsys))

		assert.Equal(t, "hello", Config.Auth.External["azure"].ClientId)
		assert.Equal(t, "this is cool", Config.Auth.External["azure"].Secret)
	})

	t.Run("config file with environment variables fails when unset", func(t *testing.T) {
		fsys := afero.NewMemMapFs()
		assert.NoError(t, WriteConfig(fsys, true))
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
