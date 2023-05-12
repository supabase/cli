package cmd

import (
	"errors"
	"os"
	"os/signal"

	env "github.com/Netflix/go-env"
	"github.com/spf13/afero"
	"github.com/spf13/cobra"
	"github.com/supabase/cli/internal/gen/keys"
	"github.com/supabase/cli/internal/gen/types/typescript"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/internal/utils/flags"
)

var (
	genCmd = &cobra.Command{
		GroupID: groupLocalDev,
		Use:     "gen",
		Short:   "Run code generation tools",
	}

	keyNames  keys.CustomName
	keyOutput = utils.EnumFlag{
		Allowed: []string{
			utils.OutputEnv,
			utils.OutputJson,
			utils.OutputToml,
			utils.OutputYaml,
		},
		Value: utils.OutputEnv,
	}

	genKeysCmd = &cobra.Command{
		Use:   "keys",
		Short: "Generate keys for preview branch",
		PersistentPreRunE: func(cmd *cobra.Command, args []string) error {
			cmd.SetHelpCommandGroupID(groupManagementAPI)
			return cmd.Root().PersistentPreRunE(cmd, args)
		},
		PreRunE: func(cmd *cobra.Command, args []string) error {
			es, err := env.EnvironToEnvSet(override)
			if err != nil {
				return err
			}
			return env.Unmarshal(es, &keyNames)
		},
		RunE: func(cmd *cobra.Command, args []string) error {
			return keys.Run(cmd.Context(), flags.ProjectRef, keyOutput.Value, keyNames, afero.NewOsFs())
		},
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
	keyFlags := genKeysCmd.Flags()
	keyFlags.StringVar(&flags.ProjectRef, "project-ref", "", "Project ref of the Supabase project.")
	keyFlags.VarP(&keyOutput, "output", "o", "Output format of key variables.")
	keyFlags.StringSliceVar(&override, "override-name", []string{}, "Override specific variable names.")
	genCmd.AddCommand(genKeysCmd)
	rootCmd.AddCommand(genCmd)
}
