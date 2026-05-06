package flags

import (
	"context"
	"fmt"
	"os"
	"strings"
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
	// Setup valid access token
	token := apitest.RandomAccessToken(t)
	t.Setenv("SUPABASE_ACCESS_TOKEN", string(token))

	t.Run("parses direct connection from db-url flag", func(t *testing.T) {
		flagSet := pflag.NewFlagSet("test", pflag.ContinueOnError)
		flagSet.String("db-url", "postgres://postgres:password@localhost:5432/postgres", "")
		err := flagSet.Set("db-url", "postgres://admin:secret@db.example.com:6432/app")
		assert.Nil(t, err)

		fsys := afero.NewMemMapFs()

		err = ParseDatabaseConfig(context.Background(), flagSet, fsys)

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

		err = ParseDatabaseConfig(context.Background(), flagSet, fsys)

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

		dbURL := fmt.Sprintf("postgres://postgres:postgres@db.%s.supabase.co:6543/postgres", project)
		err = afero.WriteFile(fsys, utils.PoolerUrlPath, []byte(dbURL), 0644)
		require.NoError(t, err)

		viper.Set("DB_PASSWORD", "test")
		err = ParseDatabaseConfig(context.Background(), flagSet, fsys)

		assert.NoError(t, err)
		assert.True(t, strings.HasPrefix(DbConfig.Host, utils.GetSupabaseDbHost(project)))
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
