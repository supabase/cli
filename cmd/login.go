package cmd

import (
	"fmt"

	"github.com/spf13/cobra"
	"github.com/supabase/cli/internal/login"
	"github.com/supabase/cli/internal/utils"
)

var (
	loginCmd = &cobra.Command{
		Use:   "login",
		Short: "Authenticate using an access token.",
		RunE: func(cmd *cobra.Command, args []string) error {
			if err := login.Run(); err != nil {
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
