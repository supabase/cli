package config

import (
	"encoding/base64"
	"os"
	"reflect"
	"strings"

	ecies "github.com/ecies/go/v2"
	"github.com/go-errors/errors"
	"github.com/go-viper/mapstructure/v2"
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

func (s *Secret) Decrypt(keys []string) error {
	if !strings.HasPrefix(s.Value, ENCRYPTED_PREFIX) {
		return nil
	}
	if len(keys) == 0 {
		return errors.New(errMissingKey)
	}
	var err error
	for _, k := range keys {
		// Use the first private key that successfully decrypts the secret
		if s.Value, err = decrypt(k, s.Value); err == nil {
			break
		}
	}
	// If we didn't break, none of the keys worked
	return err
}

var errMissingKey = errors.New("missing private key")

// Decrypt secret values following dotenvx convention:
// https://github.com/dotenvx/dotenvx/blob/main/src/lib/helpers/decryptKeyValue.js
func decrypt(key, value string) (string, error) {
	if len(key) == 0 {
		return value, errors.New(errMissingKey)
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

const PRIVATE_KEY_PREFIX = "DOTENV_PRIVATE_KEY"

func DecryptSecretHookFunc(hashKey string) mapstructure.DecodeHookFunc {
	// Get all env vars and filter for private keys
	var privateKeys []string
	for _, env := range os.Environ() {
		kv := strings.SplitN(env, "=", 2)
		if kv[0] == PRIVATE_KEY_PREFIX || strings.HasPrefix(kv[0], PRIVATE_KEY_PREFIX+"_") {
			privateKeys = append(privateKeys, strToArr(kv[1])...)
		}
	}
	return func(f reflect.Type, t reflect.Type, data interface{}) (interface{}, error) {
		if f.Kind() != reflect.String {
			return data, nil
		}
		var result Secret
		if t != reflect.TypeOf(result) {
			return data, nil
		}
		result.Value = data.(string)
		if len(result.Value) == 0 {
			return result, nil
		}
		// Unloaded env() references should be returned verbatim without hashing
		if envPattern.MatchString(result.Value) {
			return result, nil
		}
		if err := result.Decrypt(privateKeys); err != nil {
			return result, err
		}
		// Decrypted values should be hashed
		result.SHA256 = sha256Hmac(hashKey, result.Value)
		return result, nil
	}
}
