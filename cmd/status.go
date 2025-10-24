package cmd

import (
	"fmt"
	"os"
	"os/signal"

	env "github.com/Netflix/go-env"
	"github.com/spf13/afero"
	"github.com/spf13/cobra"
	"github.com/supabase/cli/internal/status"
	"github.com/supabase/cli/internal/utils"
)

var (
	override         []string
	names            status.CustomName
	useRemoteProject bool

	statusCmd = &cobra.Command{
		GroupID: groupLocalDev,
		Use:     "status",
		Short:   "Show status of local Supabase containers or remote project",
		PreRunE: func(cmd *cobra.Command, args []string) error {
			es, err := env.EnvironToEnvSet(override)
			if err != nil {
				return err
			}
			return env.Unmarshal(es, &names)
		},
		RunE: func(cmd *cobra.Command, args []string) error {
			ctx, _ := signal.NotifyContext(cmd.Context(), os.Interrupt)
			if useRemoteProject {
				fmt.Fprintf(os.Stderr, "Project health check:\n")
				return status.RunRemote(ctx, utils.OutputFormat.Value, afero.NewOsFs())
			}
			return status.Run(ctx, names, utils.OutputFormat.Value, afero.NewOsFs())
		},
		Example: `  supabase status -o env --override-name api.url=NEXT_PUBLIC_SUPABASE_URL
  supabase status -o json
  supabase status --remote`,
	}
)

func init() {
	flags := statusCmd.Flags()
	flags.StringSliceVar(&override, "override-name", []string{}, "Override specific variable names.")
	flags.BoolVar(&useRemoteProject, "remote", false, "Check health of remote project.")
	rootCmd.AddCommand(statusCmd)
}
