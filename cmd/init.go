package cmd

import (
	"fmt"

	"github.com/spf13/afero"
	"github.com/spf13/cobra"
	_init "github.com/supabase/cli/internal/init"
	"github.com/supabase/cli/internal/utils"
)

var (
	createVscodeWorkspace string

	initCmd = &cobra.Command{
		GroupID: groupLocalDev,
		Use:     "init",
		Short:   "Initialize a local project",
		RunE: func(cmd *cobra.Command, args []string) error {
			fsys := afero.NewOsFs()
			if err := _init.Run(fsys, createVscodeWorkspace); err != nil {
				return err
			}

			fmt.Println("Finished " + utils.Aqua("supabase init") + ".")
			return nil
		},
	}
)

func init() {
	flags := initCmd.Flags()
	flags.StringVar(&createVscodeWorkspace, "create-vscode-workspace", "", "Generate VS Code workspace.")
	rootCmd.AddCommand(initCmd)
}
