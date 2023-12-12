package cmd

import (
	"bytes"
	"fmt"
	"io"
	"os"
	"os/user"
	"strings"
	"time"

	"github.com/go-errors/errors"
	"github.com/google/uuid"
	"github.com/mattn/go-isatty"
	"github.com/spf13/afero"
	"github.com/spf13/cobra"
	"github.com/supabase/cli/internal/login"
	"github.com/supabase/cli/internal/utils"
	"golang.org/x/term"
)

var (
	ErrMissingToken = errors.Errorf("Cannot use automatic login flow inside non-TTY environments. Please provide %s flag or set the %s environment variable.", utils.Aqua("--token"), utils.Aqua("SUPABASE_ACCESS_TOKEN"))
)

func generateTokenName() (string, error) {
	user, err := user.Current()
	if err != nil {
		return "", errors.Errorf("cannot retrieve username: %w", err)
	}

	hostname, err := os.Hostname()
	if err != nil {
		return "", errors.Errorf("cannot retrieve hostname: %w", err)
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
					return errors.Errorf("cannot parse 'token' flag: %w", err)
				}
				params.Token = token
			} else if token := os.Getenv("SUPABASE_ACCESS_TOKEN"); token != "" {
				params.Token = token
			}

			// Login encryption and Session ID are only required for end-to-end communication.
			// We can skip it if token is already provided by user.
			if params.Token == "" {
				enc, err := login.NewLoginEncryption()
				if err != nil {
					return err
				}
				params.Encryption = enc
				params.SessionId = uuid.New().String()
			}

			if !term.IsTerminal(int(os.Stdin.Fd())) && params.Token == "" {
				return ErrMissingToken
			}

			if cmd.Flags().Changed("name") {
				name, err := cmd.Flags().GetString("name")
				if err != nil {
					return errors.Errorf("cannot parse 'name' flag: %w", err)
				}
				params.TokenName = name
			} else {
				name, err := generateTokenName()
				if err != nil {
					params.TokenName = fmt.Sprintf("cli_%d", time.Now().Unix())
				} else {
					params.TokenName = name
				}
			}

			if cmd.Flags().Changed("no-browser") {
				params.OpenBrowser = false
			} else {
				// Skip the browser if we are inside non-TTY environment, which is the case for any CI.
				params.OpenBrowser = isatty.IsTerminal(os.Stdin.Fd()) && isatty.IsTerminal(os.Stdout.Fd())
			}

			return login.Run(cmd.Context(), os.Stdout, params)
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
