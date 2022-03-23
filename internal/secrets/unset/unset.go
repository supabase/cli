package unset

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"

	"github.com/adrg/xdg"
	"github.com/supabase/cli/internal/utils"
)

func Run(args []string) error {
	// 1. Sanity checks.
	{
		if err := utils.AssertSupabaseCliIsSetUp(); err != nil {
			return err
		}
		if err := utils.AssertIsLinked(); err != nil {
			return err
		}
	}

	// 2. Unset secret(s).
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

		secretsNamesBytes, err := json.Marshal(args)
		if err != nil {
			return err
		}
		reqBody := bytes.NewReader(secretsNamesBytes)

		req, err := http.NewRequest("DELETE", "https://api.supabase.io/v1/projects/"+projectRef+"/secrets", reqBody)
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
			return errors.New("Unexpected error unsetting project secrets.")
		}
	}

	fmt.Println("Finished " + utils.Aqua("supabase secrets unset") + ".")
	return nil
}
