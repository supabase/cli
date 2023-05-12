package cmd

import (
	"os"
	"os/signal"

	"github.com/spf13/afero"
	"github.com/spf13/cobra"
	"github.com/supabase/cli/internal/restrictions/get"
	"github.com/supabase/cli/internal/restrictions/update"
	"github.com/supabase/cli/internal/utils/flags"
)

var (
	restrictionsCmd = &cobra.Command{
		GroupID: groupManagementAPI,
		Use:     "network-restrictions",
		Short:   "Manage network restrictions",
	}

	dbCidrsToAllow   []string
	bypassCidrChecks bool

	restrictionsUpdateCmd = &cobra.Command{
		Use:   "update",
		Short: "Update network restrictions",
		RunE: func(cmd *cobra.Command, args []string) error {
			fsys := afero.NewOsFs()
			if err := PromptLogin(fsys); err != nil {
				return err
			}
			if err := flags.ParseProjectRef(fsys); err != nil {
				return err
			}
			ctx, _ := signal.NotifyContext(cmd.Context(), os.Interrupt)
			return update.Run(ctx, flags.ProjectRef, dbCidrsToAllow, bypassCidrChecks, fsys)
		},
	}

	restrictionsGetCmd = &cobra.Command{
		Use:   "get",
		Short: "Get the current network restrictions",
		RunE: func(cmd *cobra.Command, args []string) error {
			fsys := afero.NewOsFs()
			if err := PromptLogin(fsys); err != nil {
				return err
			}
			if err := flags.ParseProjectRef(fsys); err != nil {
				return err
			}
			ctx, _ := signal.NotifyContext(cmd.Context(), os.Interrupt)
			return get.Run(ctx, flags.ProjectRef, fsys)
		},
	}
)

func init() {
	restrictionsCmd.PersistentFlags().StringVar(&flags.ProjectRef, "project-ref", "", "Project ref of the Supabase project.")
	restrictionsUpdateCmd.Flags().StringSliceVar(&dbCidrsToAllow, "db-allow-cidr", []string{}, "CIDR to allow DB connections from.")
	restrictionsUpdateCmd.Flags().BoolVar(&bypassCidrChecks, "bypass-cidr-checks", false, "Bypass some of the CIDR validation checks.")
	restrictionsCmd.AddCommand(restrictionsGetCmd)
	restrictionsCmd.AddCommand(restrictionsUpdateCmd)

	rootCmd.AddCommand(restrictionsCmd)
}
