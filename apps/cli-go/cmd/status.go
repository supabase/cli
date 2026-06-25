package cmd

import (
	env "github.com/Netflix/go-env"
	"github.com/spf13/afero"
	"github.com/spf13/cobra"
	"github.com/supabase/cli/internal/status"
	"github.com/supabase/cli/internal/utils"
)

var (
	override                 []string
	excludedStatusContainers []string
	ignoreStatusHealthCheck  bool
	names                    status.CustomName

	statusCmd = &cobra.Command{
		GroupID: groupLocalDev,
		Use:     "status",
		Short:   "Show status of local Supabase containers",
		PreRunE: func(cmd *cobra.Command, args []string) error {
			es, err := env.EnvironToEnvSet(override)
			if err != nil {
				return err
			}
			return env.Unmarshal(es, &names)
		},
		RunE: func(cmd *cobra.Command, args []string) error {
			return status.Run(cmd.Context(), names, utils.OutputFormat.Value, afero.NewOsFs(), ignoreStatusHealthCheck, excludedStatusContainers...)
		},
		Example: `  supabase status -o env --override-name api.url=NEXT_PUBLIC_SUPABASE_URL
  supabase status -o json`,
	}
)

func init() {
	flags := statusCmd.Flags()
	flags.StringSliceVar(&override, "override-name", []string{}, "Override specific variable names.")
	flags.StringSliceVar(&excludedStatusContainers, "exclude", []string{}, "Names of containers to omit from output.")
	cobra.CheckErr(flags.MarkHidden("exclude"))
	flags.BoolVar(&ignoreStatusHealthCheck, "ignore-health-check", false, "Ignore unhealthy services and exit 0")
	cobra.CheckErr(flags.MarkHidden("ignore-health-check"))
	rootCmd.AddCommand(statusCmd)
}
