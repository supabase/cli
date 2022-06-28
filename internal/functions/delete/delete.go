package delete

import (
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"regexp"
	"strings"

	"github.com/supabase/cli/internal/login"
	"github.com/supabase/cli/internal/utils"
)

func Run(slug string, projectRefArg string) error {
	// 1. Sanity checks.
	{
		if err := utils.AssertSupabaseCliIsSetUp(); err != nil {
			return err
		}
		if _, err := utils.LoadAccessToken(); err != nil && strings.HasPrefix(err.Error(), "Access token not provided. Supply an access token by running") {
			if err := login.Run(); err != nil {
				return err
			}
		} else if err != nil {
			return err
		}
		if len(projectRefArg) == 0 {
			if err := utils.AssertIsLinked(); err != nil {
				return err
			}
		} else {
			matched, err := regexp.MatchString(`^[a-z]{20}$`, projectRefArg)
			if err != nil {
				return err
			}
			if !matched {
				return errors.New("Invalid project ref format. Must be like `abcdefghijklmnopqrst`.")
			}
		}
		if err := utils.ValidateFunctionSlug(slug); err != nil {
			return err
		}
	}

	// 2. Delete Function.
	var projectRef string
	{
		// --project-ref overrides value on disk
		if len(projectRefArg) == 0 {
			projectRefBytes, err := os.ReadFile(".supabase/temp/project-ref")
			if err != nil {
				return err
			}
			projectRef = string(projectRefBytes)
		} else {
			projectRef = projectRefArg
		}

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

		switch resp.StatusCode {
		case http.StatusNotFound: // Function doesn't exist
			return errors.New("Function " + utils.Aqua(slug) + " does not exist on the Supabase project.")
		case http.StatusOK: // Function exists
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
		default:
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
