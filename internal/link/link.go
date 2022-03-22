package link

import (
	"errors"
	"fmt"
	"net/http"
	"os"
	"regexp"

	"github.com/adrg/xdg"
	"github.com/supabase/cli/internal/utils"
)

func Run(projectRef string) error {
	// 1. Sanity checks.
	{
		if err := utils.AssertSupabaseCliIsSetUp(); err != nil {
			return err
		}
	}

	// 2. Validate access token + project ref
	{
		matched, err := regexp.MatchString(`^[a-z]{20}$`, projectRef)
		if err != nil {
			return err
		}
		if !matched {
			return errors.New("Invalid project ref format. Must be like `abcdefghijklmnopqrst`.")
		}

		accessTokenPath, err := xdg.ConfigFile("supabase/access-token")
		if err != nil {
			return err
		}

		accessToken, err := os.ReadFile(accessTokenPath)
		if err != nil {
			return err
		}

		req, err := http.NewRequest("GET", "https://api.supabase.io/v1/projects/"+projectRef+"/functions", nil)
		if err != nil {
			return err
		}
		req.Header.Add("Authorization", "Bearer "+string(accessToken))
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			return err
		}
		if resp.StatusCode != 200 {
			return errors.New("Authorization failed for the access token and project ref pair.")
		}
	}

	// 3. Save project ref
	{
		if err := utils.MkdirIfNotExist("supabase/.temp"); err != nil {
			return err
		}
		if err := os.WriteFile("supabase/.temp/project-ref", []byte(projectRef), 0644); err != nil {
			return err
		}
	}

	fmt.Println("Finished " + utils.Aqua("supabase link") + ".")
	return nil
}
