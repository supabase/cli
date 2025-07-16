package signingkeys

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/rsa"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/go-errors/errors"
	"github.com/google/uuid"
)

type Algorithm string

const (
	AlgRS256 Algorithm = "RS256"
	AlgES256 Algorithm = "ES256"
)

type JWK struct {
	KeyType     string   `json:"kty"`
	KeyID       string   `json:"kid,omitempty"`
	Use         string   `json:"use,omitempty"`
	KeyOps      []string `json:"key_ops,omitempty"`
	Algorithm   string   `json:"alg,omitempty"`
	Extractable *bool    `json:"ext,omitempty"`
	// RSA specific fields
	Modulus  string `json:"n,omitempty"`
	Exponent string `json:"e,omitempty"`
	// RSA private key fields
	PrivateExponent         string `json:"d,omitempty"`
	FirstPrimeFactor        string `json:"p,omitempty"`
	SecondPrimeFactor       string `json:"q,omitempty"`
	FirstFactorCRTExponent  string `json:"dp,omitempty"`
	SecondFactorCRTExponent string `json:"dq,omitempty"`
	FirstCRTCoefficient     string `json:"qi,omitempty"`
	// EC specific fields
	Curve string `json:"crv,omitempty"`
	X     string `json:"x,omitempty"`
	Y     string `json:"y,omitempty"`
}

type KeyPair struct {
	PublicKey  JWK
	PrivateKey JWK
}

// GenerateKeyPair generates a new key pair for the specified algorithm
func GenerateKeyPair(alg Algorithm) (*KeyPair, error) {
	keyID := uuid.New().String()

	switch alg {
	case AlgRS256:
		return generateRSAKeyPair(keyID)
	case AlgES256:
		return generateECDSAKeyPair(keyID)
	default:
		return nil, errors.Errorf("unsupported algorithm: %s", alg)
	}
}

func generateRSAKeyPair(keyID string) (*KeyPair, error) {
	// Generate RSA key pair (2048 bits for RS256)
	privateKey, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		return nil, errors.Errorf("failed to generate RSA key: %w", err)
	}

	publicKey := &privateKey.PublicKey

	// Precompute CRT values for completeness
	privateKey.Precompute()

	// Convert to JWK format
	privateJWK := JWK{
		KeyType:                 "RSA",
		KeyID:                   keyID,
		Use:                     "sig",
		KeyOps:                  []string{"sign", "verify"},
		Algorithm:               "RS256",
		Extractable:             boolPtr(true),
		Modulus:                 base64.RawURLEncoding.EncodeToString(publicKey.N.Bytes()),
		Exponent:                base64.RawURLEncoding.EncodeToString(bigIntToBytes(publicKey.E)),
		PrivateExponent:         base64.RawURLEncoding.EncodeToString(privateKey.D.Bytes()),
		FirstPrimeFactor:        base64.RawURLEncoding.EncodeToString(privateKey.Primes[0].Bytes()),
		SecondPrimeFactor:       base64.RawURLEncoding.EncodeToString(privateKey.Primes[1].Bytes()),
		FirstFactorCRTExponent:  base64.RawURLEncoding.EncodeToString(privateKey.Precomputed.Dp.Bytes()),
		SecondFactorCRTExponent: base64.RawURLEncoding.EncodeToString(privateKey.Precomputed.Dq.Bytes()),
		FirstCRTCoefficient:     base64.RawURLEncoding.EncodeToString(privateKey.Precomputed.Qinv.Bytes()),
	}

	publicJWK := JWK{
		KeyType:     "RSA",
		KeyID:       keyID,
		Use:         "sig",
		KeyOps:      []string{"verify"},
		Algorithm:   "RS256",
		Extractable: boolPtr(true),
		Modulus:     privateJWK.Modulus,
		Exponent:    privateJWK.Exponent,
	}

	return &KeyPair{
		PublicKey:  publicJWK,
		PrivateKey: privateJWK,
	}, nil
}

func generateECDSAKeyPair(keyID string) (*KeyPair, error) {
	// Generate ECDSA key pair (P-256 curve for ES256)
	privateKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return nil, errors.Errorf("failed to generate ECDSA key: %w", err)
	}

	publicKey := &privateKey.PublicKey

	// Convert to JWK format
	privateJWK := JWK{
		KeyType:         "EC",
		KeyID:           keyID,
		Use:             "sig",
		KeyOps:          []string{"sign", "verify"},
		Algorithm:       "ES256",
		Extractable:     boolPtr(true),
		Curve:           "P-256",
		X:               base64.RawURLEncoding.EncodeToString(publicKey.X.Bytes()),
		Y:               base64.RawURLEncoding.EncodeToString(publicKey.Y.Bytes()),
		PrivateExponent: base64.RawURLEncoding.EncodeToString(privateKey.D.Bytes()),
	}

	publicJWK := JWK{
		KeyType:     "EC",
		KeyID:       keyID,
		Use:         "sig",
		KeyOps:      []string{"verify"},
		Algorithm:   "ES256",
		Extractable: boolPtr(true),
		Curve:       "P-256",
		X:           privateJWK.X,
		Y:           privateJWK.Y,
	}

	return &KeyPair{
		PublicKey:  publicJWK,
		PrivateKey: privateJWK,
	}, nil
}

// bigIntToBytes converts an integer to bytes, handling the special case of small exponents
func bigIntToBytes(n int) []byte {
	if n < 256 {
		return []byte{byte(n)}
	}
	// For larger numbers, use the standard conversion
	bytes := make([]byte, 4)
	bytes[0] = byte(n >> 24)
	bytes[1] = byte(n >> 16)
	bytes[2] = byte(n >> 8)
	bytes[3] = byte(n)
	// Remove leading zeros
	for len(bytes) > 1 && bytes[0] == 0 {
		bytes = bytes[1:]
	}
	return bytes
}

// Run generates a key pair and writes it to the specified file path
func Run(ctx context.Context, algorithm string, outputPath string) error {
	// Validate algorithm
	alg := Algorithm(strings.ToUpper(algorithm))
	if alg != AlgRS256 && alg != AlgES256 {
		return errors.Errorf("unsupported algorithm: %s. Supported algorithms: RS256, ES256", algorithm)
	}

	// Generate key pair
	keyPair, err := GenerateKeyPair(alg)
	if err != nil {
		return err
	}

	// Write to file
	return writeToFile(keyPair, outputPath)
}

// GetSupportedAlgorithms returns a list of supported algorithms
func GetSupportedAlgorithms() []string {
	return []string{string(AlgRS256), string(AlgES256)}
}

// writeToFile writes the key pair to a JSON file
func writeToFile(keyPair *KeyPair, outputPath string) error {
	// Create directory if it doesn't exist
	dir := filepath.Dir(outputPath)
	if err := os.MkdirAll(dir, 0755); err != nil {
		return errors.Errorf("failed to create directory %s: %w", dir, err)
	}

	// Create JSON array with the private key (format expected by GoTrue)
	jwkArray := []JWK{keyPair.PrivateKey}
	data, err := json.MarshalIndent(jwkArray, "", "  ")
	if err != nil {
		return errors.Errorf("failed to marshal JWT keys: %w", err)
	}

	// Write to file
	if err := os.WriteFile(outputPath, data, 0600); err != nil {
		return errors.Errorf("failed to write JWT keys to %s: %w", outputPath, err)
	}

	fmt.Printf("JWT signing keys saved to: %s\n", outputPath)
	fmt.Println("⚠️  IMPORTANT: Add this file to your .gitignore to prevent committing signing keys to version control")
	fmt.Println()
	fmt.Println("To enable JWT signing keys in your project:")
	fmt.Println("1. Add the following to your config.toml file:")
	fmt.Printf("   signing_keys_path = \"%s\"\n", outputPath)
	fmt.Println("2. Restart your local development server:")
	fmt.Println("   supabase start")
	return nil
}

// boolPtr returns a pointer to a boolean value
func boolPtr(b bool) *bool {
	return &b
}
