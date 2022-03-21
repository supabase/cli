package cmd

import (
	"github.com/spf13/cobra"
	"github.com/supabase/cli/internal/login"
)

var (
	loginCmd = &cobra.Command{
		Use:   "login",
		Short: "Authenticate using an access token.",
		RunE: func(cmd *cobra.Command, args []string) error {
			return login.Run()
		},
	}
)

func init() {
	rootCmd.AddCommand(loginCmd)
}
