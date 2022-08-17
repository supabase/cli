package cmd

import (
	"errors"

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

	local bool
	dbUrl string

	genTypesTypescriptCmd = &cobra.Command{
		Use:   "typescript",
		Short: "Generate types for TypeScript",
		Long:  "Generate types for TypeScript. Must specify either --local or --db-url",
		RunE: func(cmd *cobra.Command, args []string) error {
			if !local && dbUrl == "" {
				return errors.New("Must specify either --local or --db-url")
			}

			return typescript.Run(local, dbUrl)
		},
	}
)

func init() {
	genFlags := genTypesTypescriptCmd.Flags()
	genFlags.BoolVar(&local, "local", false, "Generate types from the local dev database.")
	genFlags.StringVar(&dbUrl, "db-url", "", "Generate types from a database url.")
	genTypesTypescriptCmd.MarkFlagsMutuallyExclusive("local", "db-url")
	genTypesCmd.AddCommand(genTypesTypescriptCmd)
	genCmd.AddCommand(genTypesCmd)
	rootCmd.AddCommand(genCmd)
}
