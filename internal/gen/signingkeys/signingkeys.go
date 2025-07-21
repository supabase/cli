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
	"io"
	"math/big"
	"os"
	"path/filepath"

	"github.com/go-errors/errors"
	"github.com/google/uuid"
	"github.com/spf13/afero"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/internal/utils/flags"
	"github.com/supabase/cli/pkg/cast"
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
		Extractable:             cast.Ptr(true),
		Modulus:                 base64.RawURLEncoding.EncodeToString(publicKey.N.Bytes()),
		Exponent:                base64.RawURLEncoding.EncodeToString(big.NewInt(int64(publicKey.E)).Bytes()),
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
		Extractable: cast.Ptr(true),
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
		Extractable:     cast.Ptr(true),
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
		Extractable: cast.Ptr(true),
		Curve:       "P-256",
		X:           privateJWK.X,
		Y:           privateJWK.Y,
	}

	return &KeyPair{
		PublicKey:  publicJWK,
		PrivateKey: privateJWK,
	}, nil
}

// Run generates a key pair and writes it to the specified file path
func Run(ctx context.Context, algorithm string, appendMode bool, fsys afero.Fs) error {
	err := flags.LoadConfig(fsys)
	if err != nil {
		return err
	}
	outputPath := utils.Config.Auth.SigningKeysPath

	// Generate key pair
	keyPair, err := GenerateKeyPair(Algorithm(algorithm))
	if err != nil {
		return err
	}

	out := io.Writer(os.Stdout)
	var jwkArray []JWK
	if len(outputPath) > 0 {
		if err := utils.MkdirIfNotExistFS(fsys, filepath.Dir(outputPath)); err != nil {
			return err
		}
		f, err := fsys.OpenFile(outputPath, os.O_RDWR|os.O_CREATE, 0600)
		if err != nil {
			return errors.Errorf("failed to open signing key: %w", err)
		}
		defer f.Close()
		if appendMode {
			// Load existing key and reset file
			dec := json.NewDecoder(f)
			// Since a new file is empty, we must ignore EOF error
			if err := dec.Decode(&jwkArray); err != nil && !errors.Is(err, io.EOF) {
				return errors.Errorf("failed to decode signing key: %w", err)
			}
			if _, err = f.Seek(0, io.SeekStart); err != nil {
				return errors.Errorf("failed to seek signing key: %w", err)
			}
		} else if fi, err := f.Stat(); fi.Size() > 0 {
			if err != nil {
				fmt.Fprintln(utils.GetDebugLogger(), err)
			}
			label := fmt.Sprintf("Do you want to overwrite the existing %s file?", utils.Bold(outputPath))
			if shouldOverwrite, err := utils.NewConsole().PromptYesNo(ctx, label, true); err != nil {
				return err
			} else if !shouldOverwrite {
				return errors.New(context.Canceled)
			}
			if err := f.Truncate(0); err != nil {
				return errors.Errorf("failed to truncate signing key: %w", err)
			}
		}
		out = f
	}
	jwkArray = append(jwkArray, keyPair.PrivateKey)

	// Write to file
	enc := json.NewEncoder(out)
	enc.SetIndent("", "  ")
	if err := enc.Encode(jwkArray); err != nil {
		return errors.Errorf("failed to encode signing key: %w", err)
	}

	if len(outputPath) == 0 {
		utils.CmdSuggestion = fmt.Sprintf(`
To enable JWT signing keys in your local project:
1. Save the generated key to %s
2. Update your %s with the new keys path

[auth]
signing_keys_path = "./signing_key.json"
`, utils.Bold(filepath.Join(utils.SupabaseDirPath, "signing_key.json")), utils.Bold(utils.ConfigPath))
		return nil
	}

	fmt.Fprintf(os.Stderr, "JWT signing key appended to: %s (now contains %d keys)\n", utils.Bold(outputPath), len(jwkArray))
	if len(jwkArray) == 1 {
		if ignored, err := utils.IsGitIgnored(outputPath); err != nil {
			fmt.Fprintln(utils.GetDebugLogger(), err)
		} else if !ignored {
			// Since the output path is user defined, we can't update the managed .gitignore file.
			fmt.Fprintln(os.Stderr, utils.Yellow("IMPORTANT:"), "Add your signing key path to .gitignore to prevent committing to version control.")
		}
	}
	return nil
}

// GetSupportedAlgorithms returns a list of supported algorithms
func GetSupportedAlgorithms() []string {
	return []string{string(AlgRS256), string(AlgES256)}
}
