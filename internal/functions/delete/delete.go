package delete

import (
	"errors"
	"fmt"
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

		accessTokenPath, err := xdg.ConfigFile("supabase/access-token")
		if err != nil {
			return err
		}
		accessToken, err := os.ReadFile(accessTokenPath)
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
			if resp.StatusCode != 200 {
				return errors.New("Failed to delete Function " + utils.Aqua(slug) + " on the Supabase project.")
			}
		} else {
			return errors.New("Unexpected error deleting Function.")
		}
	}

	fmt.Println("Deleted Function " + utils.Aqua(slug) + " from project " + utils.Aqua(projectRef) + ".")
	return nil
}
