package cmd

import (
	"fmt"

	"github.com/spf13/afero"
	"github.com/spf13/cobra"
	_init "github.com/supabase/cli/internal/init"
	"github.com/supabase/cli/internal/utils"
)

var (
	createVscodeWorkspace = new(bool)

	initCmd = &cobra.Command{
		GroupID: groupLocalDev,
		Use:     "init",
		Short:   "Initialize a local project",
		RunE: func(cmd *cobra.Command, args []string) error {
			fsys := afero.NewOsFs()
			if !cmd.Flags().Changed("with-vscode-workspace") {
				createVscodeWorkspace = nil
			}
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
	flags.BoolVar(createVscodeWorkspace, "with-vscode-workspace", false, "Generate VS Code workspace.")
	rootCmd.AddCommand(initCmd)
}
