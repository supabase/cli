package config

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"github.com/h2non/gock"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestBuildLocalJWTConfig(t *testing.T) {
	t.Run("builds config with default secret only", func(t *testing.T) {
		defer gock.OffAll()
		a := &auth{
			JwtExpiry: 3600,
			JwtIssuer: "http://localhost:54321/auth/v1",
		}
		a.JwtSecret.Value = "super-secret-jwt-token-with-at-least-32-characters-long"
		a.AnonKey.Value = "anon-key"
		a.ServiceRoleKey.Value = "service-role-key"
		a.PublishableKey.Value = "sb_publishable_test"
		a.SecretKey.Value = "sb_secret_test"

		cfg, err := a.BuildLocalJWTConfig(context.Background())
		require.NoError(t, err)

		assert.Equal(t, a.JwtSecret.Value, cfg.JwtSecret)
		assert.Equal(t, a.AnonKey.Value, cfg.AnonKey)
		assert.Equal(t, a.ServiceRoleKey.Value, cfg.ServiceRoleKey)
		assert.Equal(t, a.PublishableKey.Value, cfg.PublishableKey)
		assert.Equal(t, a.SecretKey.Value, cfg.SecretKey)
		assert.Equal(t, uint(3600), cfg.JwtExpiry)
		assert.Equal(t, "http://localhost:54321/auth/v1", cfg.JwtIssuer)
		assert.Equal(t, "HS256", cfg.ValidMethods)

		// JWKS should contain the oct key
		assert.Contains(t, cfg.JWKS, `"kty":"oct"`)
	})

	t.Run("builds config with signing keys", func(t *testing.T) {
		defer gock.OffAll()
		a := &auth{
			JwtExpiry:      3600,
			JwtIssuer:      "http://localhost:54321/auth/v1",
			SigningKeysPath: "/path/to/keys.json",
			SigningKeys: []JWK{
				{
					KeyType:   "EC",
					Algorithm: AlgES256,
					Curve:     "P-256",
					X:         "test-x",
					Y:         "test-y",
				},
			},
		}
		a.JwtSecret.Value = "super-secret-jwt-token-with-at-least-32-characters-long"

		cfg, err := a.BuildLocalJWTConfig(context.Background())
		require.NoError(t, err)

		assert.Equal(t, "HS256,ES256", cfg.ValidMethods)
		assert.NotEmpty(t, cfg.SigningKeysJSON)

		// JWKS should contain EC public key but NOT oct (since SigningKeysPath is set)
		assert.Contains(t, cfg.JWKS, `"kty":"EC"`)
		assert.NotContains(t, cfg.JWKS, `"kty":"oct"`)

		// Signing keys JSON should be parseable
		var keys []JWK
		require.NoError(t, json.Unmarshal([]byte(cfg.SigningKeysJSON), &keys))
		assert.Len(t, keys, 1)
	})

	t.Run("builds config with RS256 signing key", func(t *testing.T) {
		defer gock.OffAll()
		a := &auth{
			JwtExpiry:      3600,
			JwtIssuer:      "http://localhost:54321/auth/v1",
			SigningKeysPath: "/path/to/keys.json",
			SigningKeys: []JWK{
				{
					KeyType:   "RSA",
					Algorithm: AlgRS256,
					Modulus:   "test-n",
					Exponent:  "AQAB",
				},
			},
		}
		a.JwtSecret.Value = "super-secret-jwt-token-with-at-least-32-characters-long"

		cfg, err := a.BuildLocalJWTConfig(context.Background())
		require.NoError(t, err)

		assert.Equal(t, "HS256,RS256", cfg.ValidMethods)
	})

	t.Run("builds config without jwt secret", func(t *testing.T) {
		defer gock.OffAll()
		a := &auth{
			JwtExpiry:      3600,
			SigningKeysPath: "/path/to/keys.json",
			SigningKeys: []JWK{
				{
					KeyType:   "EC",
					Algorithm: AlgES256,
					Curve:     "P-256",
					X:         "test-x",
					Y:         "test-y",
				},
			},
		}

		cfg, err := a.BuildLocalJWTConfig(context.Background())
		require.NoError(t, err)

		assert.Equal(t, "ES256", cfg.ValidMethods)
	})
}

func TestGoTrueEnv(t *testing.T) {
	cfg := &LocalJWTConfig{
		JwtSecret:      "test-secret",
		JwtExpiry:      3600,
		JwtIssuer:      "http://localhost/auth/v1",
		SigningKeysJSON: `[{"kty":"EC"}]`,
		ValidMethods:   "HS256,ES256",
	}

	env := cfg.GoTrueEnv()

	assert.Contains(t, env, "GOTRUE_JWT_ADMIN_ROLES=service_role")
	assert.Contains(t, env, "GOTRUE_JWT_AUD=authenticated")
	assert.Contains(t, env, "GOTRUE_JWT_DEFAULT_GROUP_NAME=authenticated")
	assert.Contains(t, env, "GOTRUE_JWT_EXP=3600")
	assert.Contains(t, env, "GOTRUE_JWT_SECRET=test-secret")
	assert.Contains(t, env, "GOTRUE_JWT_ISSUER=http://localhost/auth/v1")
	assert.Contains(t, env, `GOTRUE_JWT_KEYS=[{"kty":"EC"}]`)
	assert.Contains(t, env, "GOTRUE_JWT_VALIDMETHODS=HS256,ES256")
}

func TestGoTrueEnvWithoutSigningKeys(t *testing.T) {
	cfg := &LocalJWTConfig{
		JwtSecret: "test-secret",
		JwtExpiry: 3600,
		JwtIssuer: "http://localhost/auth/v1",
	}

	env := cfg.GoTrueEnv()

	for _, e := range env {
		assert.False(t, strings.HasPrefix(e, "GOTRUE_JWT_KEYS="))
		assert.False(t, strings.HasPrefix(e, "GOTRUE_JWT_VALIDMETHODS="))
	}
}

func TestServiceEnvMethods(t *testing.T) {
	cfg := &LocalJWTConfig{
		JwtSecret:      "test-secret",
		JWKS:           `{"keys":[]}`,
		AnonKey:        "anon-key",
		ServiceRoleKey: "service-key",
		PublishableKey: "pub-key",
		SecretKey:      "sec-key",
		JwtExpiry:      3600,
		JwtIssuer:      "http://localhost/auth/v1",
	}

	t.Run("PostgREST env", func(t *testing.T) {
		env := cfg.PostgRESTEnv()
		assert.Contains(t, env, `PGRST_JWT_SECRET={"keys":[]}`)
	})

	t.Run("Realtime env", func(t *testing.T) {
		env := cfg.RealtimeEnv()
		assert.Contains(t, env, "API_JWT_SECRET=test-secret")
		assert.Contains(t, env, `API_JWT_JWKS={"keys":[]}`)
		assert.Contains(t, env, "METRICS_JWT_SECRET=test-secret")
	})

	t.Run("Storage env", func(t *testing.T) {
		env := cfg.StorageEnv()
		assert.Contains(t, env, "ANON_KEY=anon-key")
		assert.Contains(t, env, "SERVICE_KEY=service-key")
		assert.Contains(t, env, "AUTH_JWT_SECRET=test-secret")
		assert.Contains(t, env, `JWT_JWKS={"keys":[]}`)
	})

	t.Run("Studio env", func(t *testing.T) {
		env := cfg.StudioEnv()
		assert.Contains(t, env, "AUTH_JWT_SECRET=test-secret")
		assert.Contains(t, env, "SUPABASE_ANON_KEY=anon-key")
		assert.Contains(t, env, "SUPABASE_SERVICE_KEY=service-key")
	})

	t.Run("Functions env", func(t *testing.T) {
		env := cfg.FunctionsEnv()
		assert.Contains(t, env, "SUPABASE_ANON_KEY=anon-key")
		assert.Contains(t, env, "SUPABASE_SERVICE_ROLE_KEY=service-key")
		assert.Contains(t, env, "SUPABASE_INTERNAL_JWT_SECRET=test-secret")
		assert.Contains(t, env, `SUPABASE_INTERNAL_JWT_JWKS={"keys":[]}`)
	})

	t.Run("Database env", func(t *testing.T) {
		env := cfg.DatabaseEnv()
		assert.Contains(t, env, "JWT_SECRET=test-secret")
		assert.Contains(t, env, "JWT_EXP=3600")
	})

	t.Run("Pooler env", func(t *testing.T) {
		env := cfg.PoolerEnv()
		assert.Contains(t, env, "API_JWT_SECRET=test-secret")
		assert.Contains(t, env, "METRICS_JWT_SECRET=test-secret")
	})

	t.Run("Storage init env", func(t *testing.T) {
		env := cfg.StorageInitEnv()
		assert.Contains(t, env, "ANON_KEY=anon-key")
		assert.Contains(t, env, "SERVICE_KEY=service-key")
		assert.Contains(t, env, "PGRST_JWT_SECRET=test-secret")
	})

	t.Run("Auth init env", func(t *testing.T) {
		env := cfg.AuthInitEnv()
		assert.Contains(t, env, "GOTRUE_JWT_SECRET=test-secret")
	})
}

func TestSortMethods(t *testing.T) {
	methods := []string{"RS256", "HS256", "ES256"}
	sortMethods(methods)
	assert.Equal(t, []string{"HS256", "ES256", "RS256"}, methods)
}

func TestValidate(t *testing.T) {
	t.Run("valid config", func(t *testing.T) {
		cfg := &LocalJWTConfig{JwtSecret: "test"}
		assert.NoError(t, cfg.Validate())
	})

	t.Run("missing jwt secret", func(t *testing.T) {
		cfg := &LocalJWTConfig{}
		assert.Error(t, cfg.Validate())
	})
}

func TestBuildLocalJWTConfigWithThirdParty(t *testing.T) {
	t.Run("fails on unreachable OIDC endpoint", func(t *testing.T) {
		defer gock.OffAll()
		gock.New("https://example.com").
			Get("/.well-known/openid-configuration").
			Reply(http.StatusNotFound)

		a := &auth{
			JwtExpiry: 3600,
		}
		a.JwtSecret.Value = "test-secret"
		a.ThirdParty.Auth0 = tpaAuth0{
			Enabled: true,
			Tenant: "example.com",
		}

		_, err := a.BuildLocalJWTConfig(context.Background())
		assert.Error(t, err)
	})
}
