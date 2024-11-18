package config

import (
	"context"
	"fmt"
	"os"
)

type (
	secrets struct {
		// A map of secrets with the following format: `ENV_VALUE = "<encrypted-secret>"`
		BuildEnvs   map[string]string `toml:"build_envs"`
		RuntimeEnvs map[string]string `toml:"runtime_envs"`
	}
)

func SetEnvValues(envs map[string]string) error {
	for envName, envValue := range envs {
		if err := os.Setenv(envName, envValue); err != nil {
			return fmt.Errorf("failed to set default env var %s: %w", envName, err)
		}
	}
	return nil
}

func decryptSecret(encrypted string, key string) (string, error) {
	return encrypted, nil
}

func (v *secrets) DecryptBuildEnvs(ctx context.Context, secretKey string) (map[string]string, error) {
	build_envs_decrypted := make(map[string]string, len(v.BuildEnvs))

	// Decrypt build envs
	for name, encrypted := range v.BuildEnvs {
		decrypted, err := decryptSecret(encrypted, secretKey)
		if err != nil {
			return nil, fmt.Errorf("failed to decrypt build env %s: %w", name, err)
		}
		build_envs_decrypted[name] = decrypted
	}

	return build_envs_decrypted, nil
}

func (v *secrets) DecryptRuntimeEnvs(ctx context.Context, secretKey string) (map[string]string, error) {
	runtime_envs_decrypted := make(map[string]string, len(v.RuntimeEnvs))

	// Decrypt runtime envs
	for name, encrypted := range v.RuntimeEnvs {
		decrypted, err := decryptSecret(encrypted, secretKey)
		if err != nil {
			return nil, fmt.Errorf("failed to decrypt runtime env %s: %w", name, err)
		}
		runtime_envs_decrypted[name] = decrypted
	}

	return runtime_envs_decrypted, nil
}
