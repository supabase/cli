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
			accessToken, err := cmd.Flags().GetString("token")
			if err != nil {
				return err
			}

			return login.Run(accessToken)
		},
	}
)

func init() {
	loginCmd.Flags().String("token", "", "Access token to use")
	loginCmd.MarkFlagRequired("token")
	rootCmd.AddCommand(loginCmd)
}
