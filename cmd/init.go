package cmd

import (
	"fmt"

	"github.com/spf13/afero"
	"github.com/spf13/cobra"
	_init "github.com/supabase/cli/internal/init"
	"github.com/supabase/cli/internal/utils"
)

var initCmd = &cobra.Command{
	Use:   "init",
	Short: "Initialize a project to use Supabase CLI.",
	RunE: func(cmd *cobra.Command, args []string) error {
		fsys := afero.NewOsFs()
		if err := _init.Run(fsys); err != nil {
			return err
		}

		fmt.Println("Finished " + utils.Aqua("supabase init") + ".")
		return nil
	},
}

func init() {
	rootCmd.AddCommand(initCmd)
}
