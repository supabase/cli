package cmd

import (
	"errors"

	"github.com/spf13/cobra"
	"github.com/supabase/cli/internal/resolve"
)

var (
	appliedTimestamp    *string
	rolledBackTimestamp *string

	resolveCmd = &cobra.Command{
		Use:   "resolve",
		Short: "Resolve issues with migration history on the deploy database.",
		RunE: func(cmd *cobra.Command, args []string) error {
			if appliedTimestamp != nil {
				return resolve.ResolveApplied(*appliedTimestamp)
			} else if rolledBackTimestamp != nil {
				return resolve.ResolveRolledBack(*rolledBackTimestamp)
			} else {
				return errors.New("Must set either --applied or --rolled-back.")
			}
		},
	}
)

func init() {
	resolveCmd.Flags().StringVar(appliedTimestamp, "applied", "", "Migration timestamp to be recorded as applied.")
	resolveCmd.Flags().StringVar(rolledBackTimestamp, "rolled-back", "", "Migration timestamp to be recorded as rolled back.")

	rootCmd.AddCommand(resolveCmd)
}
