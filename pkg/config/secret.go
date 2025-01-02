package config

import (
	"encoding/base64"
	"fmt"
	"os"
	"strings"

	ecies "github.com/ecies/go/v2"
	"github.com/go-errors/errors"
)

type Secret string

func (s Secret) PlainText() *string {
	key := os.Getenv("DOTENV_PRIVATE_KEY")
	for _, k := range strings.Split(key, ",") {
		value, err := decrypt(k, string(s))
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
		} else if len(value) > 0 {
			return &value
		}
	}
	// Empty strings are converted to nil
	return nil
}

const ENCRYPTED_PREFIX = "encrypted:"

// Decrypt secret values following dotenvx convention:
// https://github.com/dotenvx/dotenvx/blob/main/src/lib/helpers/decryptKeyValue.js
func decrypt(key, value string) (string, error) {
	if !strings.HasPrefix(value, ENCRYPTED_PREFIX) {
		return value, nil
	}
	if len(key) == 0 {
		return value, errors.New("missing private key")
	}
	// Verify private key exists
	privateKey, err := ecies.NewPrivateKeyFromHex(key)
	if err != nil {
		return value, errors.Errorf("failed to hex decode private key: %w", err)
	}
	// Verify ciphertext is base64 encoded
	encoded := value[len(ENCRYPTED_PREFIX):]
	ciphertext, err := base64.StdEncoding.DecodeString(encoded)
	if err != nil {
		return value, errors.Errorf("failed to base64 decode secret: %w", err)
	}
	// Return decrypted value
	plaintext, err := ecies.Decrypt(privateKey, ciphertext)
	if err != nil {
		return value, errors.Errorf("failed to decrypt secret: %w", err)
	}
	return string(plaintext), nil
}
