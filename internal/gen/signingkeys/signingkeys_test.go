package signingkeys

import (
	"testing"

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
			keyPair, err := GenerateKeyPair(tt.algorithm)
			if (err != nil) != tt.wantErr {
				t.Errorf("GenerateKeyPair(%s) error = %v, wantErr %v", tt.algorithm, err, tt.wantErr)
				return
			}
			if !tt.wantErr {
				if keyPair == nil {
					t.Error("GenerateKeyPair() returned nil key pair")
					return
				}

				// Check that both public and private keys are generated
				if keyPair.PublicKey.KeyType == "" {
					t.Error("Public key type is empty")
				}
				if keyPair.PrivateKey.KeyType == "" {
					t.Error("Private key type is empty")
				}

				// Check that key IDs match
				if keyPair.PublicKey.KeyID != keyPair.PrivateKey.KeyID {
					t.Error("Public and private key IDs don't match")
				}

				// Algorithm-specific checks
				switch tt.algorithm {
				case config.AlgRS256:
					if keyPair.PublicKey.KeyType != "RSA" {
						t.Errorf("Expected RSA key type, got %s", keyPair.PublicKey.KeyType)
					}
					if keyPair.PrivateKey.Algorithm != "RS256" {
						t.Errorf("Expected RS256 algorithm, got %s", keyPair.PrivateKey.Algorithm)
					}
					// Check that RSA-specific fields are present
					if keyPair.PrivateKey.Modulus == "" {
						t.Error("RSA private key missing modulus")
					}
					if keyPair.PrivateKey.PrivateExponent == "" {
						t.Error("RSA private key missing private exponent")
					}
				case config.AlgES256:
					if keyPair.PublicKey.KeyType != "EC" {
						t.Errorf("Expected EC key type, got %s", keyPair.PublicKey.KeyType)
					}
					if keyPair.PrivateKey.Algorithm != "ES256" {
						t.Errorf("Expected ES256 algorithm, got %s", keyPair.PrivateKey.Algorithm)
					}
					// Check that EC-specific fields are present
					if keyPair.PrivateKey.Curve != "P-256" {
						t.Errorf("Expected P-256 curve, got %s", keyPair.PrivateKey.Curve)
					}
					if keyPair.PrivateKey.X == "" {
						t.Error("EC private key missing X coordinate")
					}
					if keyPair.PrivateKey.Y == "" {
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
