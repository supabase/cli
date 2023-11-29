package cmd

import (
	"os"

	"github.com/spf13/afero"
	"github.com/spf13/cobra"
	"github.com/supabase/cli/internal/logout"
)

var (
	logoutCmd = &cobra.Command{
		GroupID: groupLocalDev,
		Use:     "logout",
		Short:   "Logging out and delete access tokens",
		RunE: func(cmd *cobra.Command, args []string) error {
			params := logout.RunParams{
				Fsys: afero.NewOsFs(),
			}

			return logout.Run(cmd.Context(), os.Stdout, params)
		},
	}
)

func init() {
	rootCmd.AddCommand(logoutCmd)
}
