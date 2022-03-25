package delete

import (
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"regexp"

	"github.com/supabase/cli/internal/utils"
)

func Run(slug string) error {
	// 1. Sanity checks.
	{
		if err := utils.AssertSupabaseCliIsSetUp(); err != nil {
			return err
		}
		if err := utils.AssertIsLinked(); err != nil {
			return err
		}
	}

	// 2. Validate Function slug.
	{
		matched, err := regexp.MatchString(`^[A-Za-z0-9_-]+$`, slug)
		if err != nil {
			return err
		}
		if !matched {
			return errors.New("Invalid Function name. Must be `^[A-Za-z0-9_-]+$`.")
		}
	}

	// 3. Delete Function.
	var projectRef string
	{
		projectRefBytes, err := os.ReadFile("supabase/.temp/project-ref")
		if err != nil {
			return err
		}
		projectRef = string(projectRefBytes)

		accessToken, err := utils.LoadAccessToken()
		if err != nil {
			return err
		}

		req, err := http.NewRequest("GET", "https://api.supabase.io/v1/projects/"+projectRef+"/functions/"+slug, nil)
		if err != nil {
			return err
		}
		req.Header.Add("Authorization", "Bearer "+string(accessToken))
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			return err
		}
		defer resp.Body.Close()

		if resp.StatusCode == 404 { // Function doesn't exist
			return errors.New("Function " + utils.Aqua(slug) + " does not exist on the Supabase project.")
		} else if resp.StatusCode == 200 { // Function exists
			req, err := http.NewRequest("DELETE", "https://api.supabase.io/v1/projects/"+projectRef+"/functions/"+slug, nil)
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
					return fmt.Errorf("Failed to delete Function %v on the Supabase project: %w", utils.Aqua(slug), err)
				}

				return errors.New("Failed to delete Function " + utils.Aqua(slug) + " on the Supabase project: " + string(body))
			}
		} else {
			body, err := io.ReadAll(resp.Body)
			if err != nil {
				return fmt.Errorf("Unexpected error deleting Function: %w", err)
			}

			return errors.New("Unexpected error deleting Function: " + string(body))
		}
	}

	fmt.Println("Deleted Function " + utils.Aqua(slug) + " from project " + utils.Aqua(projectRef) + ".")
	return nil
}
