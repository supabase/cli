package bearerjwt

import (
	"bytes"
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rsa"
	_ "embed"
	"encoding/json"
	"io"
	"testing"

	"github.com/golang-jwt/jwt/v5"
	"github.com/spf13/afero"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"github.com/supabase/cli/internal/gen/signingkeys"
	"github.com/supabase/cli/internal/testing/fstest"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/pkg/config"
)

func TestGenerateToken(t *testing.T) {
	// Setup private key - ECDSA
	privateKeyECDSA, err := signingkeys.GeneratePrivateKey(config.AlgES256)
	require.NoError(t, err)
	// Setup public key for validation
	publicKeyECDSA := ecdsa.PublicKey{Curve: elliptic.P256()}
	publicKeyECDSA.X, err = config.NewBigIntFromBase64(privateKeyECDSA.X)
	require.NoError(t, err)
	publicKeyECDSA.Y, err = config.NewBigIntFromBase64(privateKeyECDSA.Y)
	require.NoError(t, err)

	// Setup private key - RSA
	privateKeyRSA, err := signingkeys.GeneratePrivateKey(config.AlgRS256)
	require.NoError(t, err)
	// Setup public key for validation
	publicKeyRSA := rsa.PublicKey{}
	publicKeyRSA.N, err = config.NewBigIntFromBase64(privateKeyRSA.Modulus)
	require.NoError(t, err)
	bigE, err := config.NewBigIntFromBase64(privateKeyRSA.Exponent)
	require.NoError(t, err)
	publicKeyRSA.E = int(bigE.Int64())

	t.Run("mints custom JWT", func(t *testing.T) {
		claims := config.CustomClaims{
			IsAnon: true,
			Role:   "authenticated",
		}
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		require.NoError(t, utils.WriteFile("supabase/config.toml", []byte(`
			[auth]
			signing_keys_path = "./keys.json"
		`), fsys))
		testKey, err := json.Marshal([]config.JWK{*privateKeyECDSA})
		require.NoError(t, err)
		require.NoError(t, utils.WriteFile("supabase/keys.json", testKey, fsys))
		// Run test
		var buf bytes.Buffer
		err = Run(context.Background(), claims, &buf, fsys)
		// Check error
		assert.NoError(t, err)
		token, err := jwt.NewParser().Parse(buf.String(), func(t *jwt.Token) (any, error) {
			return &publicKeyECDSA, nil
		})
		assert.NoError(t, err)
		assert.True(t, token.Valid)
		assert.Equal(t, map[string]any{
			"alg": "ES256",
			"kid": privateKeyECDSA.KeyID,
			"typ": "JWT",
		}, token.Header)
		assert.Equal(t, jwt.MapClaims{
			"is_anonymous": true,
			"role":         "authenticated",
		}, token.Claims)
	})

	t.Run("throws error on unsupported kty", func(t *testing.T) {
		claims := jwt.MapClaims{}
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		require.NoError(t, utils.WriteFile("supabase/config.toml", []byte(`
			[auth]
			signing_keys_path = "./keys.json"
		`), fsys))
		testKey, err := json.Marshal([]config.JWK{{KeyType: "oct"}})
		require.NoError(t, err)
		require.NoError(t, utils.WriteFile("supabase/keys.json", testKey, fsys))
		// Run test
		err = Run(context.Background(), claims, io.Discard, fsys)
		// Check error
		assert.ErrorContains(t, err, "failed to convert JWK to private key: unsupported key type: oct")
	})

	t.Run("accepts signing key from stdin", func(t *testing.T) {
		utils.Config.Auth.SigningKeysPath = ""
		utils.Config.Auth.SigningKeys = nil
		claims := config.CustomClaims{
			Role: "service_role",
		}
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		testKey, err := json.Marshal(privateKeyRSA)
		require.NoError(t, err)
		t.Cleanup(fstest.MockStdin(t, string(testKey)))
		// Run test
		var buf bytes.Buffer
		err = Run(context.Background(), claims, &buf, fsys)
		// Check error
		assert.NoError(t, err)
		token, err := jwt.NewParser().Parse(buf.String(), func(t *jwt.Token) (any, error) {
			return &publicKeyRSA, nil
		})
		assert.NoError(t, err)
		assert.True(t, token.Valid)
		assert.Equal(t, map[string]any{
			"alg": "RS256",
			"kid": privateKeyRSA.KeyID,
			"typ": "JWT",
		}, token.Header)
		assert.Equal(t, jwt.MapClaims{
			"role": "service_role",
		}, token.Claims)
	})

	t.Run("throws error on invalid key", func(t *testing.T) {
		claims := jwt.MapClaims{}
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		t.Cleanup(fstest.MockStdin(t, ""))
		// Run test
		err = Run(context.Background(), claims, io.Discard, fsys)
		// Check error
		assert.ErrorContains(t, err, "failed to parse JWK: unexpected end of JSON input")
	})

	t.Run("accepts kid from stdin", func(t *testing.T) {
		claims := jwt.MapClaims{
			"role":    "postgres",
			"sb-role": "mgmt-api",
		}
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		require.NoError(t, utils.WriteFile("supabase/config.toml", []byte(`
			[auth]
			signing_keys_path = "./keys.json"
		`), fsys))
		testKey, err := json.Marshal([]config.JWK{
			*privateKeyECDSA,
			*privateKeyRSA,
		})
		require.NoError(t, err)
		require.NoError(t, utils.WriteFile("supabase/keys.json", testKey, fsys))
		t.Cleanup(fstest.MockStdin(t, privateKeyRSA.KeyID))
		// Run test
		var buf bytes.Buffer
		err = Run(context.Background(), claims, &buf, fsys)
		// Check error
		assert.NoError(t, err)
		token, err := jwt.NewParser().Parse(buf.String(), func(t *jwt.Token) (any, error) {
			return &publicKeyRSA, nil
		})
		assert.NoError(t, err)
		assert.True(t, token.Valid)
		assert.Equal(t, map[string]any{
			"alg": "RS256",
			"kid": privateKeyRSA.KeyID,
			"typ": "JWT",
		}, token.Header)
		assert.Equal(t, jwt.MapClaims{
			"role":    "postgres",
			"sb-role": "mgmt-api",
		}, token.Claims)
	})

	t.Run("throws error on missing key", func(t *testing.T) {
		claims := jwt.MapClaims{}
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		require.NoError(t, utils.WriteFile("supabase/keys.json", []byte("[]"), fsys))
		require.NoError(t, utils.WriteFile("supabase/config.toml", []byte(`
			[auth]
			signing_keys_path = "./keys.json"
		`), fsys))
		t.Cleanup(fstest.MockStdin(t, "test-key"))
		// Run test
		err = Run(context.Background(), claims, io.Discard, fsys)
		// Check error
		assert.ErrorContains(t, err, "signing key not found: test-key")
	})
}
