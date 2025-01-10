package config

import (
	"encoding/base64"
	"os"
	"reflect"
	"strings"

	ecies "github.com/ecies/go/v2"
	"github.com/go-errors/errors"
	"github.com/mitchellh/mapstructure"
)

type Secret struct {
	Value  string
	SHA256 string
}

const HASHED_PREFIX = "hash:"

func (s Secret) MarshalText() (text []byte, err error) {
	if len(s.SHA256) == 0 {
		return []byte{}, nil
	}
	return []byte(HASHED_PREFIX + s.SHA256), nil
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

func DecryptSecretHookFunc(hashKey string) mapstructure.DecodeHookFunc {
	return func(f reflect.Type, t reflect.Type, data interface{}) (interface{}, error) {
		if f.Kind() != reflect.String {
			return data, nil
		}
		var result Secret
		if t != reflect.TypeOf(result) {
			return data, nil
		}
		var err error
		privKey := os.Getenv("DOTENV_PRIVATE_KEY")
		for _, k := range strings.Split(privKey, ",") {
			// Use the first private key that successfully decrypts the secret
			if result.Value, err = decrypt(k, data.(string)); err == nil {
				// Unloaded env() references may be returned verbatim.
				// Don't hash those values as they are meaningless.
				if !envPattern.MatchString(result.Value) {
					result.SHA256 = sha256Hmac(hashKey, result.Value)
				}
				break
			}
		}
		return result, err
	}
}
