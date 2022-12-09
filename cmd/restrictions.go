package cmd

import (
	"errors"
	"os"
	"os/signal"

	"github.com/spf13/afero"
	"github.com/spf13/cobra"
	"github.com/supabase/cli/internal/restrictions/get"
	"github.com/supabase/cli/internal/restrictions/update"
)

var (
	restrictionsCmd = &cobra.Command{
		GroupID: groupManagementAPI,
		Use:     "network-restrictions",
		Short:   "Manage network restrictions",
		PersistentPreRunE: func(cmd *cobra.Command, args []string) error {
			if !experimental {
				return errors.New("must set the --experimental flag to run this command")
			}
			return cmd.Root().PersistentPreRunE(cmd, args)
		},
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
			ctx, _ := signal.NotifyContext(cmd.Context(), os.Interrupt)
			return update.Run(ctx, projectRef, dbCidrsToAllow, bypassCidrChecks, fsys)
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
			ctx, _ := signal.NotifyContext(cmd.Context(), os.Interrupt)
			return get.Run(ctx, projectRef, fsys)
		},
	}
)

func init() {
	restrictionsCmd.PersistentFlags().StringVar(&projectRef, "project-ref", "", "Project ref of the Supabase project.")
	restrictionsUpdateCmd.Flags().StringSliceVar(&dbCidrsToAllow, "db-allow-cidr", []string{}, "CIDR to allow DB connections from.")
	restrictionsUpdateCmd.Flags().BoolVar(&bypassCidrChecks, "bypass-cidr-checks", false, "Bypass some of the CIDR validation checks.")
	restrictionsCmd.AddCommand(restrictionsGetCmd)
	restrictionsCmd.AddCommand(restrictionsUpdateCmd)

	rootCmd.AddCommand(restrictionsCmd)
}
