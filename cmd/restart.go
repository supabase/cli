package cmd

import (
	"os"
	"os/signal"

	"github.com/spf13/afero"
	"github.com/spf13/cobra"
	"github.com/supabase/cli/internal/restart"
)

var (
	restartProjectId string
	restartAll       bool

	restartCmd = &cobra.Command{
		GroupID: groupLocalDev,
		Use:     "restart",
		Short:   "Restart all local Supabase containers",
		RunE: func(cmd *cobra.Command, args []string) error {
			ctx, _ := signal.NotifyContext(cmd.Context(), os.Interrupt)
			return restart.Run(ctx, restartProjectId, restartAll, afero.NewOsFs())
		},
	}
)

func init() {
	flags := restartCmd.Flags()
	flags.Bool("backup", true, "Backs up the current database before restarting.")
	flags.StringVar(&restartProjectId, "project-id", "", "Local project ID to restart.")
	cobra.CheckErr(flags.MarkHidden("backup"))
	flags.BoolVar(&restartAll, "all", false, "Restart all local Supabase instances from all projects across the machine.")
	restartCmd.MarkFlagsMutuallyExclusive("project-id", "all")
	rootCmd.AddCommand(restartCmd)
}
