package config

import (
	"context"
	"fmt"
	"os"
	"strings"

	"github.com/jackc/pgx/v4"
)

type structuredEnv struct {
	RemoteName string
	LocalName  string
}

type (
	dynamic_env struct {
		Vault *vaultEnvProvider `toml:"vault"`
	}
	vaultEnvProvider struct {
		BuildVars              []string        `toml:"build_vars"`
		StructuredBuildEnvVars []structuredEnv `toml:"-"`
	}
)

const (
	// #nosec G101 -- This is a SQL query string, not a credential
	fetchSecretsQuery = `SELECT name, decrypted_secret FROM vault.decrypted_secrets WHERE name = ANY($1)`
)

// Get a list of env variables with possible renames like so:
// "some_env:RENAME_NAME"
// And extract them all in a structured { remoteName: "some_env", local_name: "RENAME_NAME" }
func parseEnvVars(BuildVars []string) []structuredEnv {
	result := make([]structuredEnv, len(BuildVars))

	for i, envVar := range BuildVars {
		// Find last colon
		colonIndex := strings.LastIndex(envVar, ":")

		if colonIndex > 0 {
			// Has rename format "remote:local"
			remoteName := envVar[:colonIndex]
			localName := envVar[colonIndex+1:]

			result[i] = structuredEnv{
				RemoteName: remoteName,
				LocalName:  localName,
			}
		} else {
			// No rename, use same name for both
			result[i] = structuredEnv{
				RemoteName: envVar,
				LocalName:  envVar,
			}
		}
	}

	return result
}

func setDefaultEnvValues(envs []structuredEnv, defaultValue string) error {
	// Set default values for any unset env vars
	for _, envVar := range envs {
		if os.Getenv(envVar.LocalName) == "" {
			if err := os.Setenv(envVar.LocalName, defaultValue); err != nil {
				return fmt.Errorf("failed to set default env var %s: %w", envVar.LocalName, err)
			}
		}
	}
	return nil
}

func SetEnvValues(envs map[string]string) error {
	for envName, envValue := range envs {
		if err := os.Setenv(envName, envValue); err != nil {
			return fmt.Errorf("failed to set default env var %s: %w", envName, err)
		}
	}
	return nil
}

func (d *dynamic_env) validate() error {
	if err := d.Vault.validate(); err != nil {
		return err
	}
	return nil
}

func (v *vaultEnvProvider) validate() error {
	if v == nil {
		return nil
	}
	v.StructuredBuildEnvVars = parseEnvVars(v.BuildVars)
	if err := setDefaultEnvValues(v.StructuredBuildEnvVars, "dynamic-env-from-vault"); err != nil {
		return err
	}
	return nil
}

func (v *vaultEnvProvider) FetchBuild(ctx context.Context, conn *pgx.Conn) (map[string]string, error) {
	result := make(map[string]string, len(v.StructuredBuildEnvVars))

	// Build list of remote names to query
	remoteNames := make([]string, len(v.StructuredBuildEnvVars))
	for i, envVar := range v.StructuredBuildEnvVars {
		remoteNames[i] = envVar.RemoteName
	}

	// Query vault for all secrets in one batch
	rows, err := conn.Query(ctx, fetchSecretsQuery, remoteNames)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	// Build map of remote name -> decrypted secret
	secrets := make(map[string]string)
	for rows.Next() {
		var name, secret string
		if err := rows.Scan(&name, &secret); err != nil {
			return nil, err
		}
		secrets[name] = secret
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("failed to parse rows: %w", err)
	}

	// Map remote secrets to local env var names
	for _, envVar := range v.StructuredBuildEnvVars {
		result[envVar.LocalName] = secrets[envVar.RemoteName]
	}

	return result, nil
}
