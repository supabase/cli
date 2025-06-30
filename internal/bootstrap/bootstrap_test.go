package bootstrap

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/jackc/pgconn"
	"github.com/joho/godotenv"
	"github.com/oapi-codegen/nullable"
	"github.com/spf13/afero"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"github.com/supabase/cli/internal/utils/flags"
	"github.com/supabase/cli/pkg/api"
)

func TestSuggestAppStart(t *testing.T) {
	t.Run("suggest npm", func(t *testing.T) {
		cwd, err := os.Getwd()
		require.NoError(t, err)
		// Run test
		suggestion := suggestAppStart(cwd, "npm ci && npm run dev")
		// Check error
		assert.Equal(t, "To start your app:\n  npm ci && npm run dev", suggestion)
	})

	t.Run("suggest cd", func(t *testing.T) {
		cwd, err := os.Getwd()
		require.NoError(t, err)
		// Run test
		suggestion := suggestAppStart(filepath.Dir(cwd), "npm ci && npm run dev")
		// Check error
		expected := "To start your app:"
		expected += "\n  cd " + filepath.Base(cwd)
		expected += "\n  npm ci && npm run dev"
		assert.Equal(t, expected, suggestion)
	})

	t.Run("ignore relative path", func(t *testing.T) {
		// Run test
		suggestion := suggestAppStart(".", "supabase start")
		// Check error
		assert.Equal(t, "To start your app:\n  supabase start", suggestion)
	})
}

func TestWriteEnv(t *testing.T) {
	var apiKeys = []api.ApiKeyResponse{{
		Name:   "anon",
		ApiKey: nullable.NewNullableWithValue("anonkey"),
	}, {
		Name:   "service_role",
		ApiKey: nullable.NewNullableWithValue("servicekey"),
	}}

	var dbConfig = pgconn.Config{
		Host:     "db.supabase.co",
		Port:     5432,
		User:     "admin",
		Password: "password",
		Database: "postgres",
	}

	t.Run("writes .env", func(t *testing.T) {
		flags.ProjectRef = "testing"
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		// Run test
		err := writeDotEnv(apiKeys, dbConfig, fsys)
		// Check error
		assert.NoError(t, err)
		env, err := afero.ReadFile(fsys, ".env")
		assert.NoError(t, err)
		assert.Equal(t, `POSTGRES_URL="postgresql://admin:password@db.supabase.co:6543/postgres?connect_timeout=10"
SUPABASE_ANON_KEY="anonkey"
SUPABASE_SERVICE_ROLE_KEY="servicekey"
SUPABASE_URL="https://testing.supabase.co"`, string(env))
	})

	t.Run("merges with .env.example", func(t *testing.T) {
		flags.ProjectRef = "testing"
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		example, err := godotenv.Marshal(map[string]string{
			POSTGRES_PRISMA_URL:           "example",
			POSTGRES_URL_NON_POOLING:      "example",
			POSTGRES_USER:                 "example",
			POSTGRES_HOST:                 "example",
			POSTGRES_PASSWORD:             "example",
			POSTGRES_DATABASE:             "example",
			NEXT_PUBLIC_SUPABASE_ANON_KEY: "example",
			NEXT_PUBLIC_SUPABASE_URL:      "example",
			"no_match":                    "example",
			SUPABASE_SERVICE_ROLE_KEY:     "example",
			SUPABASE_ANON_KEY:             "example",
			SUPABASE_URL:                  "example",
			POSTGRES_URL:                  "example",
		})
		require.NoError(t, err)
		require.NoError(t, afero.WriteFile(fsys, ".env.example", []byte(example), 0644))
		// Run test
		err = writeDotEnv(apiKeys, dbConfig, fsys)
		// Check error
		assert.NoError(t, err)
		env, err := afero.ReadFile(fsys, ".env")
		assert.NoError(t, err)
		assert.Equal(t, `NEXT_PUBLIC_SUPABASE_ANON_KEY="anonkey"
NEXT_PUBLIC_SUPABASE_URL="https://testing.supabase.co"
POSTGRES_DATABASE="postgres"
POSTGRES_HOST="db.supabase.co"
POSTGRES_PASSWORD="password"
POSTGRES_PRISMA_URL="postgresql://admin:password@db.supabase.co:6543/postgres?connect_timeout=10"
POSTGRES_URL="postgresql://admin:password@db.supabase.co:6543/postgres?connect_timeout=10"
POSTGRES_URL_NON_POOLING="postgresql://admin:password@db.supabase.co:5432/postgres?connect_timeout=10"
POSTGRES_USER="admin"
SUPABASE_ANON_KEY="anonkey"
SUPABASE_SERVICE_ROLE_KEY="servicekey"
SUPABASE_URL="https://testing.supabase.co"
no_match="example"`, string(env))
	})

	t.Run("throws error on malformed example", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		require.NoError(t, afero.WriteFile(fsys, ".env.example", []byte("!="), 0644))
		// Run test
		err := writeDotEnv(nil, dbConfig, fsys)
		// Check error
		assert.ErrorContains(t, err, `unexpected character "!" in variable name near "!="`)
	})

	t.Run("throws error on permission denied", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		// Run test
		err := writeDotEnv(nil, dbConfig, afero.NewReadOnlyFs(fsys))
		// Check error
		assert.ErrorIs(t, err, os.ErrPermission)
	})
}
