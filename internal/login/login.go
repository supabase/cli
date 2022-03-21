package login

import (
	"errors"
	"fmt"
	"os"
	"regexp"

	"github.com/adrg/xdg"
	"github.com/supabase/cli/internal/utils"
)

func Run() error {
	accessToken := os.Getenv("SUPABASE_ACCESS_TOKEN")

	// 1. Validate access token
	{
		if accessToken == "" {
			return errors.New("Access token not provided. Supply an access token by setting SUPABASE_ACCESS_TOKEN environment variable.")
		}

		matched, err := regexp.MatchString(`^sbp_[a-f0-9]{40}$`, accessToken)
		if err != nil {
			return err
		}
		if !matched {
			return errors.New("Invalid access token format. Must be like `sbp_0102...1920`.")
		}
	}

	// 2. Save access token
	{
		accessTokenPath, err := xdg.ConfigFile("supabase/access-token")
		if err != nil {
			return err
		}

		if err := os.WriteFile(accessTokenPath, []byte(accessToken), 0600); err != nil {
			return err
		}
	}

	fmt.Println("Finished " + utils.Aqua("supabase login") + ".")
	return nil
}
