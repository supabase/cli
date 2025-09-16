package bearerjwt

import (
	"bytes"
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	_ "embed"
	"encoding/json"
	"testing"

	"github.com/golang-jwt/jwt/v5"
	"github.com/google/uuid"
	"github.com/spf13/afero"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"github.com/supabase/cli/internal/gen/signingkeys"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/pkg/config"
)

func TestGenerateToken(t *testing.T) {
	t.Run("mints custom JWT", func(t *testing.T) {
		claims := config.CustomClaims{
			Role: "authenticated",
		}
		// Setup private key
		privateKey, err := signingkeys.GeneratePrivateKey(config.AlgES256)
		require.NoError(t, err)
		// Setup public key for validation
		publicKey := ecdsa.PublicKey{Curve: elliptic.P256()}
		publicKey.X, err = config.NewBigIntFromBase64(privateKey.X)
		require.NoError(t, err)
		publicKey.Y, err = config.NewBigIntFromBase64(privateKey.Y)
		require.NoError(t, err)
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		require.NoError(t, utils.WriteFile("supabase/config.toml", []byte(`
			[auth]
			signing_keys_path = "./keys.json"
		`), fsys))
		testKey, err := json.Marshal([]config.JWK{*privateKey})
		require.NoError(t, err)
		require.NoError(t, utils.WriteFile("supabase/keys.json", testKey, fsys))
		// Run test
		var buf bytes.Buffer
		err = Run(context.Background(), claims, &buf, fsys)
		// Check error
		assert.NoError(t, err)
		token, err := jwt.NewParser().Parse(buf.String(), func(t *jwt.Token) (any, error) {
			return &publicKey, nil
		})
		assert.NoError(t, err)
		assert.True(t, token.Valid)
		assert.Equal(t, map[string]any{
			"alg": "ES256",
			"kid": privateKey.KeyID.String(),
			"typ": "JWT",
		}, token.Header)
		assert.Equal(t, jwt.MapClaims{
			"is_anonymous": true,
			"role":         "authenticated",
		}, token.Claims)
	})

	t.Run("mints legacy JWT", func(t *testing.T) {
		utils.Config.Auth.SigningKeysPath = ""
		utils.Config.Auth.SigningKeys = nil
		claims := config.CustomClaims{
			RegisteredClaims: jwt.RegisteredClaims{
				Subject: uuid.New().String(),
			},
			Role: "authenticated",
		}
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		// Run test
		var buf bytes.Buffer
		err := Run(context.Background(), claims, &buf, fsys)
		// Check error
		assert.NoError(t, err)
		token, err := jwt.NewParser().Parse(buf.String(), func(t *jwt.Token) (any, error) {
			return []byte(utils.Config.Auth.JwtSecret.Value), nil
		})
		assert.NoError(t, err)
		assert.True(t, token.Valid)
		assert.Equal(t, map[string]any{
			"alg": "HS256",
			"typ": "JWT",
		}, token.Header)
		assert.Equal(t, jwt.MapClaims{
			"exp":  float64(1983812996),
			"iss":  "supabase-demo",
			"role": "authenticated",
			"sub":  claims.Subject,
		}, token.Claims)
	})
}
