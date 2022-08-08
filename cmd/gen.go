package cmd

import (
	"github.com/spf13/cobra"
	"github.com/supabase/cli/internal/gen/types/typescript"
)

var (
	genCmd = &cobra.Command{
		Use:   "gen",
		Short: "Run code generation tools",
	}

	genTypesCmd = &cobra.Command{
		Use:   "types",
		Short: "Generate types from Postgres schema",
	}

	genTypesTypescriptCmd = &cobra.Command{
		Use:   "typescript",
		Short: "Generate types for TypeScript. Must specify either --local or --db-url",
		RunE: func(cmd *cobra.Command, args []string) error {
			useLocal, err := cmd.Flags().GetBool("local")
			if err != nil {
				return err
			}
			dbUrl, err := cmd.Flags().GetString("db-url")
			if err != nil {
				return err
			}

			return typescript.Run(useLocal, dbUrl)
		},
	}
)

func init() {
	genTypesTypescriptCmd.Flags().Bool("local", false, "Generate types from the local dev database.")
	genTypesTypescriptCmd.Flags().String("db-url", "", "Generate types from a database url.")
	genTypesCmd.AddCommand(genTypesTypescriptCmd)
	genCmd.AddCommand(genTypesCmd)
	rootCmd.AddCommand(genCmd)
}
