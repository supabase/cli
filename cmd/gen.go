package cmd

import (
	"github.com/spf13/cobra"
	"github.com/supabase/cli/internal/gen/types/typescript"
)

var (
	genCmd = &cobra.Command{
		Use: "gen",
	}

	genTypesCmd = &cobra.Command{
		Use: "types",
	}

	genTypesTypescriptCmd = &cobra.Command{
		Use:   "typescript",
		Short: "Generate types for TypeScript. Must either specify --local, or --db-url, or be in a linked project (with supabase link)",
		RunE: func(cmd *cobra.Command, args []string) error {
			isLocal, err := cmd.Flags().GetBool("local")
			if err != nil {
				return err
			}
			dbUrl, err := cmd.Flags().GetString("db-url")
			if err != nil {
				return err
			}

			return typescript.Run(isLocal, dbUrl)
		},
	}
)

func init() {
	genTypesTypescriptCmd.Flags().Bool("local", false, "Generate types from the local dev database")
	genTypesTypescriptCmd.Flags().String("db-url", "", "Generate types from a database url")
	genTypesCmd.AddCommand(genTypesTypescriptCmd)
	genCmd.AddCommand(genTypesCmd)
	rootCmd.AddCommand(genCmd)
}
