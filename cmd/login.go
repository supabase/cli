package cmd

import (
	"bytes"
	"errors"
	"fmt"
	"io"
	"os"
	"os/user"
	"strings"
	"time"

	"github.com/mattn/go-isatty"
	"github.com/spf13/afero"
	"github.com/spf13/cobra"
	"github.com/supabase/cli/internal/login"
	"github.com/supabase/cli/internal/utils"
	"golang.org/x/term"
)

var (
	ErrMissingToken = errors.New("Cannot use automatic login flow inside non-TTY environments. Please provide " + utils.Aqua("--token") + " flag or set the " + utils.Aqua("SUPABASE_ACCESS_TOKEN") + " environment variable.")
)

func generateTokenName() (string, error) {
	user, err := user.Current()
	if err != nil {
		return "", fmt.Errorf("cannot retrieve username: %w", err)
	}

	hostname, err := os.Hostname()
	if err != nil {
		return "", fmt.Errorf("cannot retrieve hostname: %w", err)
	}

	return fmt.Sprintf("cli_%s@%s_%d", user.Username, hostname, time.Now().Unix()), nil
}

var (
	loginCmd = &cobra.Command{
		GroupID: groupLocalDev,
		Use:     "login",
		Short:   "Authenticate using an access token",
		RunE: func(cmd *cobra.Command, args []string) error {
			params := login.RunParams{
				Fsys: afero.NewOsFs(),
			}

			if !term.IsTerminal(int(os.Stdin.Fd())) {
				var buf bytes.Buffer
				if _, err := io.Copy(&buf, os.Stdin); err == nil {
					token := strings.TrimSpace(buf.String())
					if len(token) > 0 {
						params.Token = token
					}
				}
			} else if cmd.Flags().Changed("token") {
				token, err := cmd.Flags().GetString("token")
				if err != nil {
					return fmt.Errorf("cannot parse 'token' flag: %w", err)
				}
				params.Token = token
			} else if token := os.Getenv("SUPABASE_ACCESS_TOKEN"); token != "" {
				params.Token = token
			}

			if !term.IsTerminal(int(os.Stdin.Fd())) && params.Token == "" {
				return ErrMissingToken
			}

			if cmd.Flags().Changed("name") {
				name, err := cmd.Flags().GetString("name")
				if err != nil {
					return fmt.Errorf("cannot parse 'name' flag: %w", err)
				}
				params.Name = name
			} else {
				name, err := generateTokenName()
				if err != nil {
					params.Name = fmt.Sprintf("cli_%d", time.Now().Unix())
				} else {
					params.Name = name
				}
			}

			if cmd.Flags().Changed("no-browser") {
				params.OpenBrowser = false
			} else {
				// Skip the browser if we are inside non-TTY environment, which is the case for any CI.
				params.OpenBrowser = isatty.IsTerminal(os.Stdin.Fd()) && isatty.IsTerminal(os.Stdout.Fd())
			}

			return login.Run(cmd.Context(), os.Stdin, params)
		},
	}
)

func init() {
	loginFlags := loginCmd.Flags()
	loginFlags.String("token", "", "Use provided token instead of automatic login flow")
	loginFlags.String("name", "", "Name that will be used to store token in your settings, defaults to built-in token name generator")
	loginFlags.Bool("no-browser", false, "Do not open browser automatically")
	rootCmd.AddCommand(loginCmd)
}
