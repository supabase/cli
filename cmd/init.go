package cmd

import (
	"fmt"
	"os"

	"github.com/spf13/afero"
	"github.com/spf13/cobra"
	"github.com/spf13/viper"
	_init "github.com/supabase/cli/internal/init"
	"github.com/supabase/cli/internal/utils"
	"golang.org/x/term"
)

var (
	initInteractive bool
	initParams      = utils.InitParams{}

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
			ctx := cmd.Context()
			fsys := afero.NewOsFs()
			interactive := initInteractive && term.IsTerminal(int(os.Stdin.Fd()))
			return _init.Run(ctx, fsys, interactive, initParams)
		},
		PostRun: func(cmd *cobra.Command, args []string) {
			fmt.Println("Finished " + utils.Aqua("supabase init") + ".")
		},
	}
)

func init() {
	flags := initCmd.Flags()
	flags.BoolVarP(&initInteractive, "interactive", "i", false, "Enables interactive mode to configure IDE settings.")
	flags.BoolVar(&initParams.UseOrioleDB, "use-orioledb", false, "Use OrioleDB storage engine for Postgres.")
	flags.BoolVar(&initParams.Overwrite, "force", false, "Overwrite existing "+utils.ConfigPath+".")
	rootCmd.AddCommand(initCmd)
}
