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
	"github.com/supabase/cli/internal/utils/credentials"
)

func Run(stdin io.Reader, fsys afero.Fs) error {
	fmt.Fprintf(os.Stderr, `You can generate an access token from %s/account/tokens
Enter your access token: `, utils.GetSupabaseDashboardURL())

	scanner := bufio.NewScanner(stdin)
	if !scanner.Scan() {
		fmt.Println("Cancelled " + utils.Aqua("supabase login") + ".")
		return nil
	}

	accessToken := strings.TrimSpace(scanner.Text())

	// 1. Validate access token
	if !utils.AccessTokenPattern.MatchString(accessToken) {
		return errors.New("Invalid access token format. Must be like `sbp_0102...1920`.")
	}

	// 2. Save access token
	if err := credentials.Set(utils.AccessTokenKey, accessToken); err == nil {
		return nil
	}
	return fallbackSaveToken(accessToken, fsys)
}

func fallbackSaveToken(accessToken string, fsys afero.Fs) error {
	home, err := os.UserHomeDir()
	if err != nil {
		return err
	}

	configPath := filepath.Join(home, ".supabase")
	if err := utils.MkdirIfNotExistFS(fsys, configPath); err != nil {
		return err
	}

	accessTokenPath := filepath.Join(configPath, utils.AccessTokenKey)
	return afero.WriteFile(fsys, accessTokenPath, []byte(accessToken), 0600)
}
