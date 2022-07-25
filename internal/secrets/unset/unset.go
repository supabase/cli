package unset

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"

	"github.com/spf13/afero"
	"github.com/supabase/cli/internal/utils"
)

func Run(args []string, fsys afero.Fs) error {
	// 1. Sanity checks.
	{
		if err := utils.AssertSupabaseCliIsSetUpFS(fsys); err != nil {
			return err
		}
		if err := utils.AssertIsLinkedFS(fsys); err != nil {
			return err
		}
	}

	// 2. Unset secret(s).
	{
		projectRefBytes, err := afero.ReadFile(fsys, utils.ProjectRefPath)
		if err != nil {
			return err
		}
		projectRef := string(projectRefBytes)

		accessToken, err := utils.LoadAccessTokenFS(fsys)
		if err != nil {
			return err
		}

		secretsNamesBytes, err := json.Marshal(args)
		if err != nil {
			return err
		}
		reqBody := bytes.NewReader(secretsNamesBytes)

		req, err := http.NewRequest(
			"DELETE", utils.GetSupabaseAPIHost()+"/v1/projects/"+projectRef+"/secrets", reqBody)
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
				return fmt.Errorf("Unexpected error unsetting project secrets: %w", err)
			}

			return errors.New("Unexpected error unsetting project secrets: " + string(body))
		}
	}

	fmt.Println("Finished " + utils.Aqua("supabase secrets unset") + ".")
	return nil
}
