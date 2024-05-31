package set

import (
	"context"
	"fmt"
	"net/http"
	"os"
	"strings"

	"github.com/go-errors/errors"
	"github.com/joho/godotenv"
	"github.com/spf13/afero"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/pkg/api"
)

func Run(ctx context.Context, projectRef, envFilePath string, args []string, fsys afero.Fs) error {
	// 1. Sanity checks.
	// 2. Set secret(s).
	{
		var secrets api.V1BulkCreateSecretsJSONBody
		if envFilePath != "" {
			envMap, err := ParseEnvFile(envFilePath, fsys)
			if err != nil {
				return err
			}
			for name, value := range envMap {
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
		} else if len(args) == 0 {
			return errors.New("No arguments found. Use --env-file to read from a .env file.")
		} else {
			for _, pair := range args {
				name, value, found := strings.Cut(pair, "=")
				if !found {
					return errors.New("Invalid secret pair: " + utils.Aqua(pair) + ". Must be NAME=VALUE.")
				}

				secret := api.CreateSecretBody{
					Name:  name,
					Value: value,
				}
				secrets = append(secrets, secret)
			}
		}

		resp, err := utils.GetSupabase().V1BulkCreateSecretsWithResponse(ctx, projectRef, secrets)
		if err != nil {
			return errors.Errorf("failed to set secrets: %w", err)
		}

		// TODO: remove the StatusOK case after 2022-08-20
		if resp.StatusCode() != http.StatusCreated && resp.StatusCode() != http.StatusOK {
			return errors.New("Unexpected error setting project secrets: " + string(resp.Body))
		}
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
