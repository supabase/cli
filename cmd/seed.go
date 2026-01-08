package cmd

import (
	"github.com/spf13/afero"
	"github.com/spf13/cobra"
	"github.com/supabase/cli/internal/seed/buckets"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/internal/utils/flags"
)

var (
	seedCmd = &cobra.Command{
		GroupID: groupLocalDev,
		Use:     "seed",
		Short:   "Seed a Supabase project from " + utils.ConfigPath,
	}

	bucketsCmd = &cobra.Command{
		Use:   "buckets",
		Short: "Seed buckets declared in [storage.buckets]",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			return buckets.Run(cmd.Context(), flags.ProjectRef, true, afero.NewOsFs())
		},
	}
)

func init() {
	seedFlags := seedCmd.PersistentFlags()
	seedFlags.Bool("linked", false, "Seeds the linked project.")
	seedFlags.Bool("local", true, "Seeds the local database.")
	seedCmd.MarkFlagsMutuallyExclusive("local", "linked")
	seedCmd.AddCommand(bucketsCmd)
	rootCmd.AddCommand(seedCmd)
}
