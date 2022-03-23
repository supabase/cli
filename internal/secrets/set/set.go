package set

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"strings"

	"github.com/adrg/xdg"
	"github.com/supabase/cli/internal/utils"
)

func Run(readFromStdin bool, args []string) error {
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

		accessTokenPath, err := xdg.ConfigFile("supabase/access-token")
		if err != nil {
			return err
		}
		accessToken, err := os.ReadFile(accessTokenPath)
		if err != nil {
			return err
		}

		type Secret struct {
			Name  string `json:"key"`
			Value string `json:"value"`
		}

		var secrets []Secret
		if readFromStdin {
			scanner := bufio.NewScanner(os.Stdin)
			for scanner.Scan() {
				pair := strings.TrimSpace(scanner.Text())
				if pair == "" {
					continue
				}

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

		req, err := http.NewRequest("POST", "https://api.supabase.io/v1/projects/"+projectRef+"/secrets", reqBody)
		if err != nil {
			return err
		}
		req.Header.Add("Authorization", "Bearer "+string(accessToken))
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			return err
		}
		defer resp.Body.Close()

		if resp.StatusCode != 200 {
			return errors.New("Unexpected error setting project secrets.")
		}
	}

	fmt.Println("Finished " + utils.Aqua("supabase secrets set") + ".")
	return nil
}
