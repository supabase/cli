package cmd

import (
	"fmt"
	"os"

	"github.com/spf13/afero"
	"github.com/spf13/cobra"
	"github.com/supabase/cli/internal/login"
	"github.com/supabase/cli/internal/utils"
)

var (
	loginCmd = &cobra.Command{
		GroupID: "local-dev",
		Use:     "login",
		Short:   "Authenticate using an access token",
		RunE: func(cmd *cobra.Command, args []string) error {
			if err := login.Run(os.Stdin, afero.NewOsFs()); err != nil {
				return err
			}

			fmt.Println("Finished " + utils.Aqua("supabase login") + ".")
			return nil
		},
	}
)

func init() {
	rootCmd.AddCommand(loginCmd)
}
