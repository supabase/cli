package cmd

import (
    "github.com/spf13/afero"
    "github.com/spf13/cobra"
    testsDownload "github.com/supabase/cli/internal/tests/download"
    testsPush "github.com/supabase/cli/internal/tests/push"
    "github.com/supabase/cli/internal/utils/flags"
)

var (
    testsCmd = &cobra.Command{
        GroupID: groupManagementAPI,
        Use:     "tests",
        Short:   "Manage Supabase SQL tests",
    }

    testsDownloadCmd = &cobra.Command{
        Use:   "download [test-id]",
        Short: "Download one or all SQL tests",
        Args:  cobra.MaximumNArgs(1),
        RunE: func(cmd *cobra.Command, args []string) error {
            var id string
            if len(args) > 0 { id = args[0] }
            return testsDownload.Run(cmd.Context(), id, afero.NewOsFs())
        },
    }

    testsPushCmd = &cobra.Command{
        Use:   "push",
        Short: "Push local SQL tests to Supabase",
        RunE: func(cmd *cobra.Command, args []string) error {
            return testsPush.Run(cmd.Context(), afero.NewOsFs())
        },
    }
)

func init() {
    testsCmd.PersistentFlags().StringVar(&flags.ProjectRef, "project-ref", "", "Project ref of the Supabase project.")
    testsCmd.AddCommand(testsDownloadCmd)
    testsCmd.AddCommand(testsPushCmd)
    rootCmd.AddCommand(testsCmd)
} 