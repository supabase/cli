package login

import (
	"bufio"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"

	"github.com/spf13/afero"
	"github.com/supabase/cli/internal/utils"
)

func Run(stdin io.Reader, fsys afero.Fs) error {
	fmt.Printf(`You can generate an access token from %s/account/tokens
Enter your access token: `, utils.GetSupabaseDashboardURL())

	scanner := bufio.NewScanner(stdin)
	if !scanner.Scan() {
		fmt.Println("Cancelled " + utils.Aqua("supabase login") + ".")
		return nil
	}

	accessToken := strings.TrimSpace(scanner.Text())

	// 1. Validate access token
	{
		if !utils.AccessTokenPattern.MatchString(accessToken) {
			return errors.New("Invalid access token format. Must be like `sbp_0102...1920`.")
		}
	}

	// 2. Save access token
	{
		home, err := os.UserHomeDir()
		if err != nil {
			return err
		}

		configPath := filepath.Join(home, ".supabase")
		if err := utils.MkdirIfNotExistFS(fsys, configPath); err != nil {
			return err
		}

		accessTokenPath := filepath.Join(configPath, "access-token")
		if err := afero.WriteFile(fsys, accessTokenPath, []byte(accessToken), 0600); err != nil {
			return err
		}
	}

	return nil
}
