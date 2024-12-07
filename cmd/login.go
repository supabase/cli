package cmd

import (
	"os"

	"github.com/go-errors/errors"
	"github.com/spf13/afero"
	"github.com/spf13/cobra"
	"github.com/supabase/cli/internal/login"
	"github.com/supabase/cli/internal/utils"
	"golang.org/x/term"
)

var (
	ErrMissingToken = errors.Errorf("Cannot use automatic login flow inside non-TTY environments. Please provide %s flag or set the %s environment variable.", utils.Aqua("--token"), utils.Aqua("SUPABASE_ACCESS_TOKEN"))
)

var (
	params = login.RunParams{
		// Skip the browser if we are inside non-TTY environment, which is the case for any CI.
		OpenBrowser: term.IsTerminal(int(os.Stdin.Fd())),
		Fsys:        afero.NewOsFs(),
	}

	loginCmd = &cobra.Command{
		GroupID: groupLocalDev,
		Use:     "login",
		Short:   "Authenticate using an access token",
		RunE: func(cmd *cobra.Command, args []string) error {
			if params.Token == "" {
				params.Token = login.ParseAccessToken(os.Stdin)
			}
			if params.Token == "" && !params.OpenBrowser {
				return ErrMissingToken
			}
			if cmd.Flags().Changed("no-browser") {
				params.OpenBrowser = false
			}
			return login.Run(cmd.Context(), os.Stdout, params)
		},
	}
)

func init() {
	loginFlags := loginCmd.Flags()
	loginFlags.StringVar(&params.Token, "token", "", "Use provided token instead of automatic login flow")
	loginFlags.StringVar(&params.TokenName, "name", "", "Name that will be used to store token in your settings")
	loginFlags.Lookup("name").DefValue = "built-in token name generator"
	loginFlags.Bool("no-browser", false, "Do not open browser automatically")
	rootCmd.AddCommand(loginCmd)
}
