package login

import (
	"bufio"
	"errors"
	"fmt"
	"os"
	"regexp"
	"strings"

	"github.com/adrg/xdg"
	"github.com/supabase/cli/internal/utils"
)

func Run() error {
	fmt.Print(`You can generate an access token from https://app.supabase.io/account/tokens.
Enter your access token: `)

	scanner := bufio.NewScanner(os.Stdin)
	if !scanner.Scan() {
		fmt.Println("Cancelled " + utils.Aqua("supabase login") + ".")
		return nil
	}

	accessToken := strings.TrimSpace(scanner.Text())

	// 1. Validate access token
	{
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
		if err := utils.MkdirIfNotExist(xdg.Home + "/.supabase"); err != nil {
			return err
		}
		accessTokenPath := xdg.Home + "/.supabase/access-token"

		if err := os.WriteFile(accessTokenPath, []byte(accessToken), 0600); err != nil {
			return err
		}
	}

	return nil
}
