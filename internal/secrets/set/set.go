package set

import (
	"context"
	"fmt"
	"maps"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"github.com/go-errors/errors"
	"github.com/joho/godotenv"
	"github.com/spf13/afero"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/internal/utils/flags"
	"github.com/supabase/cli/pkg/api"
)

func Run(ctx context.Context, projectRef, envFilePath string, args []string, fsys afero.Fs) error {
	// 1. Sanity checks.
	if err := flags.LoadConfig(fsys); err != nil {
		fmt.Fprintln(utils.GetDebugLogger(), err)
	}
	if len(envFilePath) > 0 && !filepath.IsAbs(envFilePath) {
		envFilePath = filepath.Join(utils.CurrentDirAbs, envFilePath)
	}
	secrets, err := ListSecrets(envFilePath, fsys, args...)
	if err != nil {
		return err
	}
	if len(secrets) == 0 {
		return errors.New("No arguments found. Use --env-file to read from a .env file.")
	}
	// 2. Set secret(s).
	resp, err := utils.GetSupabase().V1BulkCreateSecretsWithResponse(ctx, projectRef, secrets)
	if err != nil {
		return errors.Errorf("failed to set secrets: %w", err)
	} else if resp.StatusCode() != http.StatusCreated {
		return errors.New("Unexpected error setting project secrets: " + string(resp.Body))
	}
	fmt.Println("Finished " + utils.Aqua("supabase secrets set") + ".")
	return nil
}

func ListSecrets(envFilePath string, fsys afero.Fs, envArgs ...string) (api.CreateSecretBody, error) {
	envMap := map[string]string{}
	for name, secret := range utils.Config.EdgeRuntime.Secrets {
		if len(secret.SHA256) > 0 {
			envMap[name] = secret.Value
		}
	}
	if len(envFilePath) > 0 {
		parsed, err := parseEnvFile(envFilePath, fsys)
		if err != nil {
			return nil, err
		}
		maps.Copy(envMap, parsed)
	}
	for _, pair := range envArgs {
		name, value, found := strings.Cut(pair, "=")
		if !found {
			return nil, errors.Errorf("Invalid secret pair: %s. Must be NAME=VALUE.", pair)
		}
		envMap[name] = value
	}
	var result api.CreateSecretBody
	for name, value := range envMap {
		// Lower case prefix is accepted by API
		if strings.HasPrefix(name, "SUPABASE_") {
			fmt.Fprintln(os.Stderr, "Env name cannot start with SUPABASE_, skipping: "+name)
			continue
		}
		result = append(result, api.CreateSecretBody{{
			Name:  name,
			Value: value,
		}}...)
	}
	return result, nil
}

func parseEnvFile(envFilePath string, fsys afero.Fs) (map[string]string, error) {
	f, err := fsys.Open(envFilePath)
	if err != nil {
		return nil, errors.Errorf("failed to open env file: %w", err)
	}
	defer f.Close()
	envMap, err := godotenv.Parse(f)
	if err != nil {
		return nil, errors.Errorf("failed to parse env file: %w", err)
	}
	return envMap, nil
}
