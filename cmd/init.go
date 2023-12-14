package cmd

import (
	"fmt"

	"github.com/spf13/afero"
	"github.com/spf13/cobra"
	"github.com/spf13/viper"
	_init "github.com/supabase/cli/internal/init"
	"github.com/supabase/cli/internal/utils"
)

var (
	createVscodeSettings = new(bool)
	useOrioleDB          bool

	initCmd = &cobra.Command{
		GroupID: groupLocalDev,
		Use:     "init",
		Short:   "Initialize a local project",
		PersistentPreRunE: func(cmd *cobra.Command, args []string) error {
			if !viper.IsSet("WORKDIR") {
				// Prevents recursing to parent directory
				viper.Set("WORKDIR", ".")
			}
			return cmd.Root().PersistentPreRunE(cmd, args)
		},
		PreRun: func(cmd *cobra.Command, args []string) {
			cmd.MarkFlagsRequiredTogether("use-orioledb", "experimental")
		},
		RunE: func(cmd *cobra.Command, args []string) error {
			fsys := afero.NewOsFs()
			if !cmd.Flags().Changed("with-vscode-settings") {
				createVscodeSettings = nil
			}
			return _init.Run(fsys, createVscodeSettings, useOrioleDB)
		},
		PostRun: func(cmd *cobra.Command, args []string) {
			fmt.Println("Finished " + utils.Aqua("supabase init") + ".")
		},
	}
)

func init() {
	flags := initCmd.Flags()
	flags.BoolVar(createVscodeSettings, "with-vscode-workspace", false, "Generate VS Code workspace.")
	cobra.CheckErr(flags.MarkHidden("with-vscode-workspace"))
	flags.BoolVar(createVscodeSettings, "with-vscode-settings", false, "Generate VS Code settings for Deno.")
	flags.BoolVar(&useOrioleDB, "use-orioledb", false, "Use OrioleDB storage engine for Postgres")
	rootCmd.AddCommand(initCmd)
}
