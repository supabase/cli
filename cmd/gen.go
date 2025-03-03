package cmd

import (
	"os"
	"os/signal"

	env "github.com/Netflix/go-env"
	"github.com/go-errors/errors"
	"github.com/spf13/afero"
	"github.com/spf13/cobra"
	"github.com/supabase/cli/internal/gen/keys"
	"github.com/supabase/cli/internal/gen/types"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/internal/utils/flags"
)

var (
	genCmd = &cobra.Command{
		GroupID: groupLocalDev,
		Use:     "gen",
		Short:   "Run code generation tools",
	}

	keyNames keys.CustomName

	genKeysCmd = &cobra.Command{
		Use:   "keys",
		Short: "Generate keys for preview branch",
		PersistentPreRunE: func(cmd *cobra.Command, args []string) error {
			es, err := env.EnvironToEnvSet(override)
			if err != nil {
				return err
			}
			if err := env.Unmarshal(es, &keyNames); err != nil {
				return err
			}
			cmd.GroupID = groupManagementAPI
			return cmd.Root().PersistentPreRunE(cmd, args)
		},
		RunE: func(cmd *cobra.Command, args []string) error {
			format := utils.OutputFormat.Value
			if format == utils.OutputPretty {
				format = utils.OutputEnv
			}
			return keys.Run(cmd.Context(), flags.ProjectRef, format, keyNames, afero.NewOsFs())
		},
	}

	lang = utils.EnumFlag{
		Allowed: []string{
			types.LangTypescript,
			types.LangGo,
			types.LangSwift,
		},
		Value: types.LangTypescript,
	}
	postgrestV9Compat  bool
	swiftAccessControl = utils.EnumFlag{
		Allowed: []string{
			types.SwiftInternalAccessControl,
			types.SwiftPublicAccessControl,
		},
		Value: types.SwiftInternalAccessControl,
	}

	genTypesCmd = &cobra.Command{
		Use:   "types",
		Short: "Generate types from Postgres schema",
		PreRunE: func(cmd *cobra.Command, args []string) error {
			if postgrestV9Compat && !cmd.Flags().Changed("db-url") {
				return errors.New("--postgrest-v9-compat must used together with --db-url")
			}
			// Legacy commands specify language using arg, eg. gen types typescript
			if len(args) > 0 && args[0] != types.LangTypescript && !cmd.Flags().Changed("lang") {
				return errors.New("use --lang flag to specify the typegen language")
			}
			return nil
		},
		RunE: func(cmd *cobra.Command, args []string) error {
			ctx, _ := signal.NotifyContext(cmd.Context(), os.Interrupt)
			if flags.DbConfig.Host == "" {
				// If no flag is specified, prompt for project id.
				if err := flags.ParseProjectRef(ctx, afero.NewMemMapFs()); errors.Is(err, utils.ErrNotLinked) {
					return errors.New("Must specify one of --local, --linked, --project-id, or --db-url")
				} else if err != nil {
					return err
				}
			}
			return types.Run(ctx, flags.ProjectRef, flags.DbConfig, lang.Value, schema, postgrestV9Compat, swiftAccessControl.Value, afero.NewOsFs())
		},
		Example: `  supabase gen types --local
  supabase gen types --linked --lang=go
  supabase gen types --project-id abc-def-123 --schema public --schema private
  supabase gen types --db-url 'postgresql://...' --schema public --schema auth`,
	}
)

func init() {
	typeFlags := genTypesCmd.Flags()
	typeFlags.Bool("local", false, "Generate types from the local dev database.")
	typeFlags.Bool("linked", false, "Generate types from the linked project.")
	typeFlags.String("db-url", "", "Generate types from a database url.")
	typeFlags.StringVar(&flags.ProjectRef, "project-id", "", "Generate types from a project ID.")
	genTypesCmd.MarkFlagsMutuallyExclusive("local", "linked", "project-id", "db-url")
	typeFlags.Var(&lang, "lang", "Output language of the generated types.")
	typeFlags.StringSliceVarP(&schema, "schema", "s", []string{}, "Comma separated list of schema to include.")
	typeFlags.Var(&swiftAccessControl, "swift-access-control", "Access control for Swift generated types.")
	typeFlags.BoolVar(&postgrestV9Compat, "postgrest-v9-compat", false, "Generate types compatible with PostgREST v9 and below. Only use together with --db-url.")
	genCmd.AddCommand(genTypesCmd)
	keyFlags := genKeysCmd.Flags()
	keyFlags.StringVar(&flags.ProjectRef, "project-ref", "", "Project ref of the Supabase project.")
	keyFlags.StringSliceVar(&override, "override-name", []string{}, "Override specific variable names.")
	genCmd.AddCommand(genKeysCmd)
	rootCmd.AddCommand(genCmd)
}
