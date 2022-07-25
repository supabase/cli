package cmd

import (
	"github.com/spf13/afero"
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
			return list.Run(afero.NewOsFs())
		},
	}

	secretsSetCmd = &cobra.Command{
		Use:   "set [flags] <NAME=VALUE> ...",
		Short: "Set a secret(s) to the linked Supabase project.",
		RunE: func(cmd *cobra.Command, args []string) error {
			envFilePath, err := cmd.Flags().GetString("env-file")
			if err != nil {
				return err
			}

			return set.Run(envFilePath, args, afero.NewOsFs())
		},
	}

	secretsUnsetCmd = &cobra.Command{
		Use:   "unset <NAME> ...",
		Short: "Unset a secret(s) from the linked Supabase project.",
		RunE: func(cmd *cobra.Command, args []string) error {
			return unset.Run(args, afero.NewOsFs())
		},
	}
)

func init() {
	secretsSetCmd.Flags().String("env-file", "", "Read secrets from a .env file.")
	secretsCmd.AddCommand(secretsListCmd)
	secretsCmd.AddCommand(secretsSetCmd)
	secretsCmd.AddCommand(secretsUnsetCmd)
	rootCmd.AddCommand(secretsCmd)
}
