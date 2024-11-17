package config

import (
	"context"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/supabase/cli/pkg/pgtest"
)

func TestGetEnvVars(t *testing.T) {
	t.Run("simple env vars without rename", func(t *testing.T) {
		input := []string{"SIMPLE_VAR", "ANOTHER_VAR"}
		result := parseEnvVars(input)

		assert.Equal(t, 2, len(result))
		assert.Equal(t, "SIMPLE_VAR", result[0].RemoteName)
		assert.Equal(t, "SIMPLE_VAR", result[0].LocalName)
		assert.Equal(t, "ANOTHER_VAR", result[1].RemoteName)
		assert.Equal(t, "ANOTHER_VAR", result[1].LocalName)
	})

	t.Run("env vars with rename", func(t *testing.T) {
		input := []string{"remote:LOCAL", "another-remote:LOCAL_NAME"}
		result := parseEnvVars(input)

		assert.Equal(t, 2, len(result))
		assert.Equal(t, "remote", result[0].RemoteName)
		assert.Equal(t, "LOCAL", result[0].LocalName)
		assert.Equal(t, "another-remote", result[1].RemoteName)
		assert.Equal(t, "LOCAL_NAME", result[1].LocalName)
	})

	t.Run("env vars with escaped colons", func(t *testing.T) {
		input := []string{
			"remote:with:colons:LOCAL",
			"remote:colon:LOCAL_NAME",
		}
		result := parseEnvVars(input)

		assert.Equal(t, 2, len(result))
		assert.Equal(t, "remote:with:colons", result[0].RemoteName)
		assert.Equal(t, "LOCAL", result[0].LocalName)
		assert.Equal(t, "remote:colon", result[1].RemoteName)
		assert.Equal(t, "LOCAL_NAME", result[1].LocalName)
	})

	t.Run("env vars with spaces in local name", func(t *testing.T) {
		input := []string{
			"remote:LOCAL_NAME_WITH_SPACES",
			"another-remote:SPACED_LOCAL_NAME",
		}
		result := parseEnvVars(input)

		assert.Equal(t, 2, len(result))
		assert.Equal(t, "remote", result[0].RemoteName)
		assert.Equal(t, "LOCAL_NAME_WITH_SPACES", result[0].LocalName)
		assert.Equal(t, "another-remote", result[1].RemoteName)
		assert.Equal(t, "SPACED_LOCAL_NAME", result[1].LocalName)
	})

	t.Run("env vars with spaces in remote name", func(t *testing.T) {
		input := []string{
			"remote name with spaces:LOCAL",
			"another remote name:LOCAL_NAME",
		}
		result := parseEnvVars(input)

		assert.Equal(t, 2, len(result))
		assert.Equal(t, "remote name with spaces", result[0].RemoteName)
		assert.Equal(t, "LOCAL", result[0].LocalName)
		assert.Equal(t, "another remote name", result[1].RemoteName)
		assert.Equal(t, "LOCAL_NAME", result[1].LocalName)
	})

	t.Run("empty input", func(t *testing.T) {
		result := parseEnvVars([]string{})
		assert.Equal(t, 0, len(result))
	})
}
func TestDynamicEnvValidate(t *testing.T) {
	t.Run("valid vault config", func(t *testing.T) {
		config := &dynamic_env{
			Vault: &vaultEnvProvider{
				BuildVars: []string{
					"remote:LOCAL",
					"another:LOCAL_NAME",
				},
			},
		}
		err := config.validate()
		assert.NoError(t, err)
		assert.Equal(t, 2, len(config.Vault.StructuredBuildEnvVars))
	})

	t.Run("nil vault config", func(t *testing.T) {
		config := &dynamic_env{
			Vault: nil,
		}
		err := config.validate()
		assert.NoError(t, err)
	})
}
func TestVaultEnvProviderFetch(t *testing.T) {
	t.Run("fetches secrets from vault", func(t *testing.T) {
		ctx := context.Background()

		provider := &vaultEnvProvider{
			BuildVars: []string{
				"remote:LOCAL",
				"another:LOCAL_NAME",
			},
		}
		err := provider.validate()
		assert.NoError(t, err)

		// Setup mock postgres
		conn := pgtest.NewConn()
		defer conn.Close(t)

		conn.Query(
			fetchSecretsQuery,
			[]string{"remote", "another"},
		).Reply("SELECT 2",
			[]interface{}{"remote", "secret1"},
			[]interface{}{"another", "secret2"},
		)

		result, err := provider.FetchBuild(ctx, conn.MockClient(t))
		assert.NoError(t, err)
		assert.Equal(t, map[string]string{
			"LOCAL":      "secret1",
			"LOCAL_NAME": "secret2",
		}, result)
	})

	t.Run("handles missing secrets", func(t *testing.T) {
		ctx := context.Background()
		provider := &vaultEnvProvider{
			BuildVars: []string{
				"remote:LOCAL",
				"missing:OTHER",
			},
		}
		err := provider.validate()
		assert.NoError(t, err)

		// Setup mock postgres
		conn := pgtest.NewConn()
		t.Cleanup(func() { conn.Close(t) })

		conn.Query(
			fetchSecretsQuery,
			[]string{"remote", "missing"},
		).Reply("SELECT 1", []interface{}{"remote", "secret1"})

		result, err := provider.FetchBuild(ctx, conn.MockClient(t))
		assert.NoError(t, err)
		assert.Equal(t, map[string]string{
			"LOCAL": "secret1",
			"OTHER": "", // Missing secret returns empty string
		}, result)
	})
}
