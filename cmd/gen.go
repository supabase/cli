package cmd

import (
	"errors"
	"os"
	"os/signal"

	"github.com/spf13/afero"
	"github.com/spf13/cobra"
	"github.com/supabase/cli/internal/gen/types/typescript"
)

var (
	genCmd = &cobra.Command{
		GroupID: "local-dev",
		Use:     "gen",
		Short:   "Run code generation tools",
	}

	genTypesCmd = &cobra.Command{
		Use:   "types",
		Short: "Generate types from Postgres schema",
	}

	local     bool
	linked    bool
	projectId string
	dbUrl     string
	schemas   []string

	genTypesTypescriptCmd = &cobra.Command{
		Use:   "typescript",
		Short: "Generate types for TypeScript",
		Long:  "Generate types for TypeScript. Must specify one of --local, --linked, --project-id, or --db-url",
		RunE: func(cmd *cobra.Command, args []string) error {
			if !local && !linked && projectId == "" && dbUrl == "" {
				return errors.New("Must specify one of --local, --linked, --project-id, or --db-url")
			}

			ctx, _ := signal.NotifyContext(cmd.Context(), os.Interrupt)
			return typescript.Run(ctx, local, linked, projectId, dbUrl, schemas, afero.NewOsFs())
		},
		Example: `  supabase gen types typescript --local
  supabase gen types typescript --linked
  supabase gen types typescript --project-id abc-def-123 --schema public --schema private
  supabase gen types typescript --db-url 'postgresql://...' --schema public --schema auth`,
	}
)

func init() {
	genFlags := genTypesTypescriptCmd.Flags()
	genFlags.BoolVar(&local, "local", false, "Generate types from the local dev database.")
	genFlags.BoolVar(&linked, "linked", false, "Generate types from the linked project.")
	genFlags.StringVar(&projectId, "project-id", "", "Generate types from a project ID.")
	genFlags.StringVar(&dbUrl, "db-url", "", "Generate types from a database url.")
	genFlags.StringArrayVar(&schemas, "schema", []string{}, "Schemas to generate types for.")
	genTypesTypescriptCmd.MarkFlagsMutuallyExclusive("local", "linked", "project-id", "db-url")
	genTypesCmd.AddCommand(genTypesTypescriptCmd)
	genCmd.AddCommand(genTypesCmd)
	rootCmd.AddCommand(genCmd)
}
