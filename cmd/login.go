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
		GroupID: groupLocalDev,
		Use:     "login",
		Short:   "Authenticate using an access token",
		RunE: func(cmd *cobra.Command, args []string) error {
			return login.Run(os.Stdin, afero.NewOsFs())
		},
		PostRun: func(cmd *cobra.Command, args []string) {
			fmt.Println("Finished " + utils.Aqua("supabase login") + ".")
		},
	}
)

func init() {
	rootCmd.AddCommand(loginCmd)
}
