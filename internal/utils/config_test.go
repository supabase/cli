package utils

import (
	"testing"

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
