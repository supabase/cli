package set

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strings"

	"github.com/joho/godotenv"
	"github.com/spf13/afero"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/pkg/api"
)

func Run(ctx context.Context, projectRef, envFilePath string, args []string, fsys afero.Fs) error {
	// 1. Sanity checks.
	// 2. Set secret(s).
	{
		var secrets api.CreateSecretsJSONBody
		if envFilePath != "" {
			envMap, err := godotenv.Read(envFilePath)
			if err != nil {
				return err
			}
			for name, value := range envMap {
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

		resp, err := utils.GetSupabase().CreateSecretsWithResponse(ctx, projectRef, secrets)
		if err != nil {
			return err
		}

		// TODO: remove the StatusOK case after 2022-08-20
		if resp.StatusCode() != http.StatusCreated && resp.StatusCode() != http.StatusOK {
			return errors.New("Unexpected error setting project secrets: " + string(resp.Body))
		}
	}

	fmt.Println("Finished " + utils.Aqua("supabase secrets set") + ".")
	return nil
}
