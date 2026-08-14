package cmd

import (
	env "github.com/Netflix/go-env"
	"github.com/spf13/afero"
	"github.com/spf13/cobra"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/internal/utils/flags"
	"github.com/supabase/cli/legacy/keys"
)

var (
	genCmd = &cobra.Command{
		GroupID: groupLocalDev,
		Use:     "gen",
		Short:   "Run code generation tools",
	}

	keyNames keys.CustomName
	override []string

	genKeysCmd = &cobra.Command{
		Deprecated: `use "gen signing-key" instead.`,
		Use:        "keys",
		Short:      "Generate keys for preview branch",
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
)

func init() {
	keyFlags := genKeysCmd.Flags()
	keyFlags.StringVar(&flags.ProjectRef, "project-ref", "", "Project ref of the Supabase project.")
	markFlagTelemetrySafe(keyFlags.Lookup("project-ref"))
	keyFlags.StringSliceVar(&override, "override-name", []string{}, "Override specific variable names.")
	genCmd.AddCommand(genKeysCmd)
	rootCmd.AddCommand(genCmd)
}
