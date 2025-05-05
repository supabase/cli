package flags

import (
	"os"
	"testing"

	"github.com/spf13/afero"
	"github.com/spf13/pflag"
	"github.com/spf13/viper"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"github.com/supabase/cli/internal/testing/apitest"
	"github.com/supabase/cli/internal/utils"
)

func TestParseDatabaseConfig(t *testing.T) {
	t.Run("parses direct connection from db-url flag", func(t *testing.T) {
		flagSet := pflag.NewFlagSet("test", pflag.ContinueOnError)
		flagSet.String("db-url", "postgres://postgres:password@localhost:5432/postgres", "")
		err := flagSet.Set("db-url", "postgres://admin:secret@db.example.com:6432/app")
		assert.Nil(t, err)

		fsys := afero.NewMemMapFs()

		err = ParseDatabaseConfig(flagSet, fsys)

		assert.NoError(t, err)
		assert.Equal(t, "db.example.com", DbConfig.Host)
		assert.Equal(t, uint16(6432), DbConfig.Port)
		assert.Equal(t, "admin", DbConfig.User)
		assert.Equal(t, "secret", DbConfig.Password)
		assert.Equal(t, "app", DbConfig.Database)
	})

	t.Run("parses local connection", func(t *testing.T) {
		flagSet := pflag.NewFlagSet("test", pflag.ContinueOnError)
		flagSet.Bool("local", false, "")
		err := flagSet.Set("local", "true")
		assert.Nil(t, err)

		fsys := afero.NewMemMapFs()

		utils.Config.Hostname = "localhost"
		utils.Config.Db.Port = 54322
		utils.Config.Db.Password = "local-password"

		err = ParseDatabaseConfig(flagSet, fsys)

		assert.NoError(t, err)
		assert.Equal(t, "localhost", DbConfig.Host)
		assert.Equal(t, uint16(54322), DbConfig.Port)
		assert.Equal(t, "postgres", DbConfig.User)
		assert.Equal(t, "local-password", DbConfig.Password)
		assert.Equal(t, "postgres", DbConfig.Database)
	})

	t.Run("parses linked connection", func(t *testing.T) {
		flagSet := pflag.NewFlagSet("test", pflag.ContinueOnError)
		flagSet.Bool("linked", false, "")
		err := flagSet.Set("linked", "true")
		assert.Nil(t, err)

		fsys := afero.NewMemMapFs()

		project := apitest.RandomProjectRef()
		err = afero.WriteFile(fsys, utils.ProjectRefPath, []byte(project), 0644)
		require.NoError(t, err)

		err = ParseDatabaseConfig(flagSet, fsys)

		assert.NoError(t, err)
		assert.Equal(t, utils.GetSupabaseDbHost(project), DbConfig.Host)
	})
}

func TestPromptPassword(t *testing.T) {
	t.Run("returns user input when provided", func(t *testing.T) {
		r, w, err := os.Pipe()
		require.NoError(t, err)
		defer r.Close()
		go func() {
			defer w.Close()
			_, err := w.Write([]byte("test-password"))
			assert.Nil(t, err)
		}()

		password := PromptPassword(r)

		assert.Equal(t, "test-password", password)
	})

	t.Run("generates password when input is empty", func(t *testing.T) {
		r, w, err := os.Pipe()
		require.NoError(t, err)
		defer r.Close()
		go func() {
			defer w.Close()
			_, err := w.Write([]byte(""))
			assert.Nil(t, err)
		}()

		password := PromptPassword(r)

		assert.Len(t, password, PASSWORD_LENGTH)
		assert.NotEqual(t, "", password)
	})
}

func TestGetDbConfigOptionalPassword(t *testing.T) {
	t.Run("uses environment variable when available", func(t *testing.T) {
		viper.Set("DB_PASSWORD", "env-password")
		projectRef := apitest.RandomProjectRef()

		config := GetDbConfigOptionalPassword(projectRef)

		assert.Equal(t, "env-password", config.Password)
	})
}
