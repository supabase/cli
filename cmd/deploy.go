package cmd

import (
	"context"
	"fmt"
	"os"
	"os/signal"

	"github.com/go-errors/errors"
	"github.com/spf13/afero"
	"github.com/spf13/cobra"
	"github.com/spf13/viper"
	configPush "github.com/supabase/cli/internal/config/push"
	"github.com/supabase/cli/internal/db/push"
	funcDeploy "github.com/supabase/cli/internal/functions/deploy"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/internal/utils/flags"
	"github.com/supabase/cli/pkg/api"
	"github.com/supabase/cli/pkg/function"
)

var (
	// Deploy flags
	deployDryRun       bool
	deployIncludeAll   bool
	deployIncludeRoles bool
	deployIncludeSeed  bool

	deployCmd = &cobra.Command{
		GroupID: groupLocalDev,
		Use:     "deploy",
		Short:   "Push all local changes to a Supabase project",
		Long: `Deploy local changes to a remote Supabase project.

By default, this command will:
  - Push database migrations (supabase db push)
  - Deploy edge functions (supabase functions deploy)

You can optionally include config changes with --include-config.
Use individual flags to customize what gets deployed.`,
		// PreRunE: func(cmd *cobra.Command, args []string) error {
		// 	return cmd.Root().PersistentPreRunE(cmd, args)
		// },
		RunE: func(cmd *cobra.Command, args []string) error {
			ctx, _ := signal.NotifyContext(cmd.Context(), os.Interrupt)
			fsys := afero.NewOsFs()

			// Determine components to deploy
			includeDb := true
			includeFunctions := true
			includeConfig := true

			fmt.Fprintln(os.Stderr, utils.Bold("Deploying to project:"), flags.ProjectRef)

			spinner := utils.NewSpinner("Connecting to project")
			spinner.Start(context.Background())
			cancelSpinner := spinner.Start(context.Background())
			defer cancelSpinner()
			if !isProjectHealthy(ctx) {
				spinner.Fail("Project is not healthy. Please ensure all services are running before deploying.")
				return errors.New("project is not healthy")
			}
			spinner.Stop("Connected to project")

			var deployErrors []error

			// Maybe deploy database migrations
			if includeDb {
				fmt.Fprintln(os.Stderr, utils.Aqua(">>>")+" Deploying database migrations...")
				if err := push.Run(ctx, deployDryRun, deployIncludeAll, deployIncludeRoles, deployIncludeSeed, flags.DbConfig, fsys); err != nil {
					deployErrors = append(deployErrors, errors.Errorf("db push failed: %w", err))
					return err // Stop on DB errors as functions might depend on schema
				}
				fmt.Fprintln(os.Stderr, "")
			}

			// Maybe deploy edge functions
			if includeFunctions {
				fmt.Fprintln(os.Stderr, utils.Aqua(">>>")+" Deploying edge functions...")
				keep := func(name string) bool {
					if deployDryRun {
						fmt.Fprintln(os.Stderr, utils.Yellow("⏭ ")+"Would deploy:", name)
						return false
					}
					return true
				}
				if err := funcDeploy.Run(ctx, []string{}, true, nil, "", 1, false, fsys, keep); err != nil && !errors.Is(err, function.ErrNoDeploy) {
					deployErrors = append(deployErrors, errors.Errorf("functions deploy failed: %w", err))
					fmt.Fprintln(os.Stderr, utils.Yellow("WARNING:")+" Functions deployment failed:", err)
				} else if errors.Is(err, function.ErrNoDeploy) {
					fmt.Fprintln(os.Stderr, utils.Yellow("⏭ ")+"No functions to deploy")
				} else {
					// print error just in case
					fmt.Fprintln(os.Stderr, err)
					if deployDryRun {
						fmt.Fprintln(os.Stderr, utils.Aqua("✓")+" Functions dry run complete")
					} else {
						fmt.Fprintln(os.Stderr, utils.Aqua("✓")+" Functions deployed successfully")
					}
				}
				fmt.Fprintln(os.Stderr, "")
			}

			// Maybe deploy config
			if includeConfig {
				fmt.Fprintln(os.Stderr, utils.Aqua(">>>")+" Deploying config...")
				if err := configPush.Run(ctx, flags.ProjectRef, deployDryRun, fsys); err != nil {
					deployErrors = append(deployErrors, errors.Errorf("config push failed: %w", err))
					fmt.Fprintln(os.Stderr, utils.Yellow("WARNING:")+" Config deployment failed:", err)
				} else {
					if deployDryRun {
						fmt.Fprintln(os.Stderr, utils.Aqua("✓")+" Config dry run complete")
					} else {
						fmt.Fprintln(os.Stderr, utils.Aqua("✓")+" Config deployed successfully")
					}
				}
				fmt.Fprintln(os.Stderr, "")
			}

			// Summary
			if len(deployErrors) > 0 {
				if deployDryRun {
					fmt.Fprintln(os.Stderr, utils.Yellow("Dry run completed with warnings:"))
				} else {
					fmt.Fprintln(os.Stderr, utils.Yellow("Deploy completed with warnings:"))
				}
				for _, err := range deployErrors {
					fmt.Fprintln(os.Stderr, " •", err)
				}
				return nil // Don't fail the command for non-critical errors
			}

			if deployDryRun {
				fmt.Fprintln(os.Stderr, utils.Aqua("✓")+" "+utils.Bold("Dry run completed successfully!"))
			} else {
				fmt.Fprintln(os.Stderr, utils.Aqua("✓")+" "+utils.Bold("Deployment completed successfully!"))
			}
			return nil
		},
		Example: `  supabase deploy
  supabase deploy --include-config
  supabase deploy --include-db --include-functions
  supabase deploy --dry-run`,
	}
)

func init() {
	cmdFlags := deployCmd.Flags()

	cmdFlags.BoolVar(&deployDryRun, "dry-run", false, "Print operations that would be performed without executing them")

	cmdFlags.String("db-url", "", "Deploys to the database specified by the connection string (must be percent-encoded)")
	cmdFlags.Bool("linked", true, "Deploys to the linked project")
	cmdFlags.Bool("local", false, "Deploys to the local database")
	deployCmd.MarkFlagsMutuallyExclusive("db-url", "linked", "local")
	cmdFlags.StringVarP(&dbPassword, "password", "p", "", "Password to your remote Postgres database")
	cobra.CheckErr(viper.BindPFlag("DB_PASSWORD", cmdFlags.Lookup("password")))
	cmdFlags.StringVar(&flags.ProjectRef, "project-ref", "", "Project ref of the Supabase project")

	rootCmd.AddCommand(deployCmd)
}
func isProjectHealthy(ctx context.Context) bool {
	services := []api.V1GetServicesHealthParamsServices{
		api.Auth,
		// Not checking Realtime for now as it can be flaky
		// api.Realtime,
		api.Rest,
		api.Storage,
		api.Db,
	}
	resp, err := utils.GetSupabase().V1GetServicesHealthWithResponse(ctx, flags.ProjectRef, &api.V1GetServicesHealthParams{
		Services: services,
	})
	if err != nil {
		// return errors.Errorf("failed to check remote health: %w", err)
		return false
	}
	if resp.JSON200 == nil {
		// return errors.New("Unexpected error checking remote health: " + string(resp.Body))
		return false
	}
	for _, service := range *resp.JSON200 {
		if !service.Healthy {
			return false
		}
	}
	return true
}
