package jwkkeys

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
	"strings"

	"github.com/go-errors/errors"
	"github.com/google/uuid"
	"github.com/supabase/cli/internal/utils"
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

type OutputFormat string

const (
	FormatJWKS OutputFormat = "jwks"
	FormatEnv  OutputFormat = "env"
)

// Run generates a key pair and outputs it in the specified format
func Run(ctx context.Context, algorithm string, format string) error {
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

	// Handle custom formats directly, use utils.EncodeOutput for standard formats
	outputFormat := OutputFormat(format)
	switch outputFormat {
	case FormatJWKS:
		// Handle JWKS format directly
		output := formatOutput(keyPair, outputFormat)
		data, err := json.MarshalIndent(output, "", "  ")
		if err != nil {
			return errors.Errorf("failed to marshal output: %w", err)
		}
		_, err = os.Stdout.Write(data)
		if err != nil {
			return errors.Errorf("failed to write output: %w", err)
		}
		fmt.Fprintln(os.Stdout) // Add newline
		return nil
	case FormatEnv:
		// For env format, use utils.EncodeOutput for proper env variable formatting
		return utils.EncodeOutput("env", os.Stdout, formatOutput(keyPair, outputFormat))
	default:
		// For json and other standard formats, use utils.EncodeOutput
		return utils.EncodeOutput(format, os.Stdout, formatOutput(keyPair, outputFormat))
	}
}

func formatOutput(keyPair *KeyPair, format OutputFormat) interface{} {
	switch format {
	case FormatJWKS:
		// Return JWKS format with the private key
		return map[string]interface{}{
			"keys": []JWK{keyPair.PrivateKey},
		}
	case FormatEnv:
		// Return environment variable format - GoTrue expects array of JWKs, not JWKS object
		jwkArray := []JWK{keyPair.PrivateKey}
		jwkArrayBytes, _ := json.Marshal(jwkArray)
		return map[string]string{
			"GOTRUE_JWT_KEYS": string(jwkArrayBytes),
		}
	default:
		// Default to single private key JWK (for json format)
		return keyPair.PrivateKey
	}
}

// GetSupportedAlgorithms returns a list of supported algorithms
func GetSupportedAlgorithms() []string {
	return []string{string(AlgRS256), string(AlgES256)}
}

// boolPtr returns a pointer to a boolean value
func boolPtr(b bool) *bool {
	return &b
}
