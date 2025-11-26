package cmd

import (
	"os"
	"os/signal"

	"github.com/spf13/afero"
	"github.com/spf13/cobra"
	"github.com/spf13/viper"
	"github.com/supabase/cli/internal/deploy"
	"github.com/supabase/cli/internal/utils/flags"
)

var (
	deployCmd = &cobra.Command{
		GroupID: groupQuickStart,
		Use:     "deploy",
		Short:   "Push all local changes to a Supabase project",
		Long: `Deploy local changes to a remote Supabase project.

By default, this command will:
  - Push database migrations (supabase db push)
  - Deploy edge functions (supabase functions deploy)

You can optionally include config changes with --include-config.
Use individual flags to customize what gets deployed.`,
		RunE: func(cmd *cobra.Command, args []string) error {
			ctx, _ := signal.NotifyContext(cmd.Context(), os.Interrupt)
			fsys := afero.NewOsFs()
			return deploy.Run(ctx, dryRun, fsys)
		},
		Example: `  supabase deploy
  supabase deploy --include-config
  supabase deploy --include-db --include-functions
  supabase deploy --dry-run`,
	}
)

func init() {
	cmdFlags := deployCmd.Flags()
	cmdFlags.BoolVar(&dryRun, "dry-run", false, "Print operations that would be performed without executing them")
	cmdFlags.String("db-url", "", "Deploys to the database specified by the connection string (must be percent-encoded)")
	cmdFlags.Bool("linked", true, "Deploys to the linked project")
	cmdFlags.Bool("local", false, "Deploys to the local database")
	deployCmd.MarkFlagsMutuallyExclusive("db-url", "linked", "local")
	cmdFlags.StringVarP(&dbPassword, "password", "p", "", "Password to your remote Postgres database")
	cobra.CheckErr(viper.BindPFlag("DB_PASSWORD", cmdFlags.Lookup("password")))
	cmdFlags.StringVar(&flags.ProjectRef, "project-ref", "", "Project ref of the Supabase project")
	rootCmd.AddCommand(deployCmd)
}
