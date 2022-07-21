package link

import (
	"errors"
	"fmt"
	"io"
	"net/http"

	"github.com/spf13/afero"
	"github.com/supabase/cli/internal/utils"
)

func Run(projectRef string, fsys afero.Fs) error {
	// 1. Validate access token + project ref
	{
		if !utils.ProjectRefPattern.MatchString(projectRef) {
			return errors.New("Invalid project ref format. Must be like `abcdefghijklmnopqrst`.")
		}

		accessToken, err := utils.LoadAccessTokenFS(fsys)
		if err != nil {
			return err
		}

		supabaseAPI := os.Getenv("SUPABASE_INTERNAL_API_HOST")
		if supabaseAPI == "" {
			supabaseAPI = "https://api.supabase.io"
		}
		req, err := http.NewRequest("GET", supabaseAPI+"/v1/projects/"+projectRef+"/functions", nil)
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
			body, err := io.ReadAll(resp.Body)
			if err != nil {
				return fmt.Errorf("Authorization failed for the access token and project ref pair: %w", err)
			}

			return errors.New("Authorization failed for the access token and project ref pair: " + string(body))
		}
	}

	// 2. Save project ref
	{
		if err := utils.MkdirIfNotExistFS(fsys, "supabase"); err != nil {
			return err
		}
		if err := utils.MkdirIfNotExistFS(fsys, "supabase/.temp"); err != nil {
			return err
		}
		if err := afero.WriteFile(fsys, "supabase/.temp/project-ref", []byte(projectRef), 0644); err != nil {
			return err
		}
	}

	return nil
}
