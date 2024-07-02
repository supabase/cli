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
	"github.com/supabase/cli/pkg/api"
)

func Run(ctx context.Context, projectRef, envFilePath string, args []string, fsys afero.Fs) error {
	// 1. Sanity checks.
	envMap := make(map[string]string, len(args))
	if len(envFilePath) > 0 {
		if !filepath.IsAbs(envFilePath) {
			envFilePath = filepath.Join(utils.CurrentDirAbs, envFilePath)
		}
		parsed, err := ParseEnvFile(envFilePath, fsys)
		if err != nil {
			return err
		}
		maps.Copy(envMap, parsed)
	}
	for _, pair := range args {
		name, value, found := strings.Cut(pair, "=")
		if !found {
			return errors.Errorf("Invalid secret pair: %s. Must be NAME=VALUE.", pair)
		}
		envMap[name] = value
	}
	if len(envMap) == 0 {
		return errors.New("No arguments found. Use --env-file to read from a .env file.")
	}
	// 2. Set secret(s).
	var secrets api.V1BulkCreateSecretsJSONBody
	for name, value := range envMap {
		// Lower case prefix is accepted by API
		if strings.HasPrefix(name, "SUPABASE_") {
			fmt.Fprintln(os.Stderr, "Env name cannot start with SUPABASE_, skipping: "+name)
			continue
		}
		secret := api.CreateSecretBody{
			Name:  name,
			Value: value,
		}
		secrets = append(secrets, secret)
	}

	resp, err := utils.GetSupabase().V1BulkCreateSecretsWithResponse(ctx, projectRef, secrets)
	if err != nil {
		return errors.Errorf("failed to set secrets: %w", err)
	}

	if resp.StatusCode() != http.StatusCreated {
		return errors.New("Unexpected error setting project secrets: " + string(resp.Body))
	}

	fmt.Println("Finished " + utils.Aqua("supabase secrets set") + ".")
	return nil
}

func ParseEnvFile(envFilePath string, fsys afero.Fs) (map[string]string, error) {
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
