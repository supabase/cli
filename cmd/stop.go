package cmd

import (
	"os"
	"os/signal"

	"github.com/spf13/afero"
	"github.com/spf13/cobra"
	"github.com/supabase/cli/internal/stop"
)

var (
	noBackup  bool
	projectId string
	all       bool

	stopCmd = &cobra.Command{
		GroupID: groupLocalDev,
		Use:     "stop",
		Short:   "Stop all local Supabase containers",
		RunE: func(cmd *cobra.Command, args []string) error {
			ctx, _ := signal.NotifyContext(cmd.Context(), os.Interrupt)
			return stop.Run(ctx, !noBackup, projectId, all, afero.NewOsFs())
		},
	}
)

func init() {
	flags := stopCmd.Flags()
	flags.Bool("backup", true, "Backs up the current database before stopping.")
	flags.StringVar(&projectId, "project-id", "", "Local project ID to stop.")
	cobra.CheckErr(flags.MarkHidden("backup"))
	flags.BoolVar(&noBackup, "no-backup", false, "Deletes all data volumes after stopping.")
	flags.BoolVar(&all, "all", false, "Stop all local Supabase instances from all projects across the machine.")
	stopCmd.MarkFlagsMutuallyExclusive("project-id", "all")
	rootCmd.AddCommand(stopCmd)
}
