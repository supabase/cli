package signingkeys

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"github.com/spf13/afero"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"github.com/supabase/cli/internal/testing/fstest"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/pkg/config"
)

func TestGenerateKeyPair(t *testing.T) {
	tests := []struct {
		name      string
		algorithm config.Algorithm
		wantErr   bool
	}{
		{
			name:      "RSA key generation",
			algorithm: config.AlgRS256,
			wantErr:   false,
		},
		{
			name:      "ECDSA key generation",
			algorithm: config.AlgES256,
			wantErr:   false,
		},
		{
			name:      "unsupported algorithm",
			algorithm: "UNSUPPORTED",
			wantErr:   true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			privateJWK, err := GeneratePrivateKey(tt.algorithm)
			if (err != nil) != tt.wantErr {
				t.Errorf("GenerateKeyPair(%s) error = %v, wantErr %v", tt.algorithm, err, tt.wantErr)
				return
			}
			if !tt.wantErr {
				if privateJWK == nil {
					t.Error("GenerateKeyPair() returned nil key pair")
					return
				}

				// Check that both public and private keys are generated
				publicJWK := privateJWK.ToPublicJWK()
				if publicJWK.KeyType == "" {
					t.Error("Public key type is empty")
				}
				if privateJWK.KeyType == "" {
					t.Error("Private key type is empty")
				}

				// Check that key IDs match
				if publicJWK.KeyID != privateJWK.KeyID {
					t.Error("Public and private key IDs don't match")
				}

				// Algorithm-specific checks
				switch tt.algorithm {
				case config.AlgRS256:
					if publicJWK.KeyType != "RSA" {
						t.Errorf("Expected RSA key type, got %s", publicJWK.KeyType)
					}
					if privateJWK.Algorithm != "RS256" {
						t.Errorf("Expected RS256 algorithm, got %s", privateJWK.Algorithm)
					}
					// Check that RSA-specific fields are present
					if privateJWK.Modulus == "" {
						t.Error("RSA private key missing modulus")
					}
					if privateJWK.PrivateExponent == "" {
						t.Error("RSA private key missing private exponent")
					}
				case config.AlgES256:
					if publicJWK.KeyType != "EC" {
						t.Errorf("Expected EC key type, got %s", publicJWK.KeyType)
					}
					if privateJWK.Algorithm != "ES256" {
						t.Errorf("Expected ES256 algorithm, got %s", privateJWK.Algorithm)
					}
					// Check that EC-specific fields are present
					if privateJWK.Curve != "P-256" {
						t.Errorf("Expected P-256 curve, got %s", privateJWK.Curve)
					}
					if privateJWK.X == "" {
						t.Error("EC private key missing X coordinate")
					}
					if privateJWK.Y == "" {
						t.Error("EC private key missing Y coordinate")
					}
				}
			}
		})
	}
}

func TestGetSupportedAlgorithms(t *testing.T) {
	algorithms := GetSupportedAlgorithms()
	expected := []string{"RS256", "ES256"}

	if len(algorithms) != len(expected) {
		t.Errorf("GetSupportedAlgorithms() length = %d, expected %d", len(algorithms), len(expected))
		return
	}

	for i, alg := range algorithms {
		if alg != expected[i] {
			t.Errorf("GetSupportedAlgorithms()[%d] = %s, expected %s", i, alg, expected[i])
		}
	}
}

func TestSigningKey(t *testing.T) {
	t.Run("generates signing key", func(t *testing.T) {
		fsys := afero.NewMemMapFs()
		err := Run(context.Background(), "ES256", false, fsys)
		assert.NoError(t, err)
	})

	t.Run("throws error on permission denied", func(t *testing.T) {
		fsys := &fstest.OpenErrorFs{DenyPath: utils.ConfigPath}
		err := Run(context.Background(), "ES256", false, fsys)
		assert.ErrorIs(t, err, os.ErrPermission)
	})

	t.Run("throws error on encode failure", func(t *testing.T) {
		oldStdout := os.Stdout
		t.Cleanup(func() { os.Stdout = oldStdout })
		os.Stdout = nil
		// Run test
		fsys := afero.NewMemMapFs()
		err := Run(context.Background(), "ES256", false, fsys)
		assert.ErrorIs(t, err, os.ErrInvalid)
	})
}

func TestAppendKey(t *testing.T) {
	// Setup in-memory fs
	fsys := afero.NewMemMapFs()
	keyPath := filepath.Join(utils.SupabaseDirPath, "signing_keys.json")
	require.NoError(t, utils.WriteFile(keyPath, []byte(`[]`), fsys))
	require.NoError(t, utils.WriteFile(utils.ConfigPath, []byte(`
[auth]
signing_keys_path = "./signing_keys.json"
`), fsys))

	t.Run("overwrites signing key", func(t *testing.T) {
		t.Cleanup(fstest.MockStdin(t, "y"))
		err := Run(context.Background(), "ES256", false, fsys)
		assert.NoError(t, err)
	})

	t.Run("throws error on context cancelled", func(t *testing.T) {
		t.Cleanup(fstest.MockStdin(t, "y"))
		ctx, cancel := context.WithCancel(context.Background())
		cancel()
		// Run test
		err := Run(ctx, "ES256", false, afero.NewReadOnlyFs(fsys))
		assert.ErrorIs(t, err, context.Canceled)
	})

	t.Run("throws error on no answer", func(t *testing.T) {
		t.Cleanup(fstest.MockStdin(t, "n"))
		err := Run(context.Background(), "ES256", false, afero.NewReadOnlyFs(fsys))
		assert.ErrorIs(t, err, context.Canceled)
	})

	t.Run("appends signing key", func(t *testing.T) {
		err := Run(context.Background(), "ES256", true, fsys)
		assert.NoError(t, err)
	})

	t.Run("throws error on write failure", func(t *testing.T) {
		err := Run(context.Background(), "ES256", true, afero.NewReadOnlyFs(fsys))
		assert.ErrorIs(t, err, os.ErrPermission)
	})
}
