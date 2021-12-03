package cmd

import (
	"github.com/spf13/cobra"
	_init "github.com/supabase/cli/internal/init"
)

var initCmd = &cobra.Command{
	Use:   "init",
	Short: "Initialize a project to use Supabase CLI.",
	RunE: func(cmd *cobra.Command, args []string) error {
		return _init.Run()
	},
}

func init() {
	rootCmd.AddCommand(initCmd)
}
