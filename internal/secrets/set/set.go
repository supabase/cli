package set

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"

	"github.com/joho/godotenv"
	"github.com/supabase/cli/internal/utils"
)

func Run(envFilePath string, args []string) error {
	// 1. Sanity checks.
	{
		if err := utils.AssertSupabaseCliIsSetUp(); err != nil {
			return err
		}
		if err := utils.AssertIsLinked(); err != nil {
			return err
		}
	}

	// 2. Set secret(s).
	{
		projectRefBytes, err := os.ReadFile("supabase/.temp/project-ref")
		if err != nil {
			return err
		}
		projectRef := string(projectRefBytes)

		accessToken, err := utils.LoadAccessToken()
		if err != nil {
			return err
		}

		type Secret struct {
			Name  string `json:"name"`
			Value string `json:"value"`
		}

		var secrets []Secret
		if envFilePath != "" {
			envMap, err := godotenv.Read(envFilePath)
			if err != nil {
				return err
			}
			for name, value := range envMap {
				secret := Secret{
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

				secret := Secret{
					Name:  name,
					Value: value,
				}
				secrets = append(secrets, secret)
			}
		}

		secretsBytes, err := json.Marshal(secrets)
		if err != nil {
			return err
		}
		reqBody := bytes.NewReader(secretsBytes)

		req, err := http.NewRequest("POST", utils.GetSupabaseAPIHost()+"/v1/projects/"+projectRef+"/secrets", reqBody)
		if err != nil {
			return err
		}
		req.Header.Add("Authorization", "Bearer "+string(accessToken))
		req.Header.Add("Content-Type", "application/json")
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			return err
		}
		defer resp.Body.Close()

		if resp.StatusCode != 200 {
			body, err := io.ReadAll(resp.Body)
			if err != nil {
				return fmt.Errorf("Unexpected error setting project secrets: %w", err)
			}

			return errors.New("Unexpected error setting project secrets: " + string(body))
		}
	}

	fmt.Println("Finished " + utils.Aqua("supabase secrets set") + ".")
	return nil
}
