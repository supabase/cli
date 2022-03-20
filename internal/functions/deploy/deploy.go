package deploy

import (
	"bytes"
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"regexp"

	"github.com/adrg/xdg"
	"github.com/supabase/cli/internal/utils"
)

func Run(slug string) error {
	// 1. Sanity checks.
	{
		if err := utils.AssertSupabaseCliIsSetUp(); err != nil {
			return err
		}
	}

	// 2. Validate Function slug.
	var newFunctionBody string
	{
		matched, err := regexp.MatchString(`^[A-Za-z0-9_-]+$`, slug)
		if err != nil {
			return err
		}
		if !matched {
			return errors.New("Invalid Function name. Must be `^[A-Za-z0-9_-]+$`.")
		}

		newFunctionBodyBytes, err := os.ReadFile("supabase/functions/" + slug + ".ts")
		if err != nil {
			return err
		}
		newFunctionBody = string(newFunctionBodyBytes)
	}

	// 3. Deploy new Function.
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

		req, err := http.NewRequest("GET", "https://api.supabase.io/v1/functions/"+projectRef+"/"+slug, nil)
		if err != nil {
			return err
		}
		req.Header.Add("Authorization", "Bearer "+string(accessToken))
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			return err
		}

		if resp.StatusCode == 404 { // Function doesn't exist yet, so do a POST
			jsonBytes, err := json.Marshal(map[string]string{"slug": slug, "name": slug, "body": newFunctionBody})
			if err != nil {
				return err
			}

			req, err := http.NewRequest("POST", "https://api.supabase.io/v1/functions/"+projectRef, bytes.NewReader(jsonBytes))
			if err != nil {
				return err
			}
			req.Header.Add("Authorization", "Bearer "+string(accessToken))
			req.Header.Add("Content-Type", "application/json")
			resp, err := http.DefaultClient.Do(req)
			if err != nil {
				return err
			}
			if resp.StatusCode != 200 {
				return errors.New("Failed to create a new Function on the Supabase project.")
			}
		} else if resp.StatusCode == 200 { // Function already exists, so do a PATCH
			jsonBytes, err := json.Marshal(map[string]string{"body": newFunctionBody})
			if err != nil {
				return err
			}

			req, err := http.NewRequest("PATCH", "https://api.supabase.io/v1/functions/"+projectRef+"/"+slug, bytes.NewReader(jsonBytes))
			if err != nil {
				return err
			}
			req.Header.Add("Authorization", "Bearer "+string(accessToken))
			req.Header.Add("Content-Type", "application/json")
			resp, err := http.DefaultClient.Do(req)
			if err != nil {
				return err
			}
			if resp.StatusCode != 200 {
				return errors.New("Failed to update an existing Function's body on the Supabase project.")
			}
		} else {
			return errors.New("Unexpected error deploying Function.")
		}
	}

	return nil
}
