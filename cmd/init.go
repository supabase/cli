package cmd

import (
	"fmt"
	"os"
	"os/signal"

	"github.com/spf13/afero"
	"github.com/spf13/cobra"
	"github.com/spf13/viper"
	_init "github.com/supabase/cli/internal/init"
	"github.com/supabase/cli/internal/utils"
)

var (
	createVscodeSettings   = new(bool)
	createIntellijSettings = new(bool)
	initParams             = utils.InitParams{}

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
			if initParams.UseOrioleDB {
				cobra.CheckErr(cmd.MarkFlagRequired("experimental"))
			}
		},
		RunE: func(cmd *cobra.Command, args []string) error {
			fsys := afero.NewOsFs()
			if !cmd.Flags().Changed("with-vscode-settings") && !cmd.Flags().Changed("with-vscode-workspace") {
				createVscodeSettings = nil
			}

			if !cmd.Flags().Changed("with-intellij-settings") {
				createIntellijSettings = nil
			}
			ctx, _ := signal.NotifyContext(cmd.Context(), os.Interrupt)
			return _init.Run(ctx, fsys, createVscodeSettings, createIntellijSettings, initParams)
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
	flags.BoolVar(createIntellijSettings, "with-intellij-settings", false, "Generate IntelliJ IDEA settings for Deno.")
	flags.BoolVar(&initParams.UseOrioleDB, "use-orioledb", false, "Use OrioleDB storage engine for Postgres.")
	flags.BoolVar(&initParams.Overwrite, "force", false, "Overwrite existing "+utils.ConfigPath+".")
	rootCmd.AddCommand(initCmd)
}
