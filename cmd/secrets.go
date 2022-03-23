package cmd

import (
	"github.com/spf13/cobra"
	"github.com/supabase/cli/internal/secrets/list"
	"github.com/supabase/cli/internal/secrets/set"
	"github.com/supabase/cli/internal/secrets/unset"
)

var (
	secretsCmd = &cobra.Command{
		Use:   "secrets",
		Short: "Supabase secrets",
	}

	secretsListCmd = &cobra.Command{
		Use:   "list",
		Short: "List all secrets in the linked project.",
		RunE: func(cmd *cobra.Command, args []string) error {
			return list.Run()
		},
	}

	secretsSetCmd = &cobra.Command{
		Use:   "set [flags] <KEY=VALUE> ...",
		Short: "Set a secret(s) to the linked Supabase project.",
		RunE: func(cmd *cobra.Command, args []string) error {
			readFromStdin, err := cmd.Flags().GetBool("from-stdin")
			if err != nil {
				return err
			}

			return set.Run(readFromStdin, args)
		},
	}

	secretsUnsetCmd = &cobra.Command{
		Use:   "unset <KEY> ...",
		Short: "Unset a key(s) from the linked Supabase project.",
		RunE: func(cmd *cobra.Command, args []string) error {
			return unset.Run(args)
		},
	}
)

func init() {
	secretsSetCmd.Flags().Bool("from-stdin", false, "Read secrets in newline-delimited KEY=VALUE pairs from stdin.")
	secretsCmd.AddCommand(secretsListCmd)
	secretsCmd.AddCommand(secretsSetCmd)
	secretsCmd.AddCommand(secretsUnsetCmd)
	rootCmd.AddCommand(secretsCmd)
}
