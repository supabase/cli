package cmd

import (
	"fmt"
	"os"
	"os/signal"

	"github.com/go-errors/errors"
	"github.com/spf13/afero"
	"github.com/spf13/cobra"
	"github.com/spf13/viper"
	configPush "github.com/supabase/cli/internal/config/push"
	"github.com/supabase/cli/internal/db/push"
	"github.com/supabase/cli/internal/functions/deploy"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/internal/utils/flags"
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

			// Load config
			// if err := flags.LoadConfig(fsys); err != nil {
			// 	return err
			// }

			// Determine what to deploy
			// If no specific flags are set, default to db and functions
			includeDb, _ := cmd.Flags().GetBool("include-db")
			includeFunctions, _ := cmd.Flags().GetBool("include-functions")
			includeConfig, _ := cmd.Flags().GetBool("include-config")

			fmt.Fprintln(os.Stderr, utils.Bold("Deploying to project:"), flags.ProjectRef)
			fmt.Fprintln(os.Stderr, "")

			var deployErrors []error

			// 1. Deploy config first (if requested)
			if includeConfig {
				fmt.Fprintln(os.Stderr, utils.Aqua(">>>")+" Deploying config...")
				if err := configPush.Run(ctx, flags.ProjectRef, fsys); err != nil {
					deployErrors = append(deployErrors, errors.Errorf("config push failed: %w", err))
					fmt.Fprintln(os.Stderr, utils.Yellow("WARNING:")+" Config deployment failed:", err)
				} else {
					fmt.Fprintln(os.Stderr, utils.Aqua("✓")+" Config deployed successfully")
				}
				fmt.Fprintln(os.Stderr, "")
			}

			// 2. Deploy database migrations
			if includeDb {
				fmt.Fprintln(os.Stderr, utils.Aqua(">>>")+" Deploying database migrations...")
				if err := push.Run(ctx, deployDryRun, deployIncludeAll, deployIncludeRoles, deployIncludeSeed, flags.DbConfig, fsys); err != nil {
					deployErrors = append(deployErrors, errors.Errorf("db push failed: %w", err))
					return err // Stop on DB errors as functions might depend on schema
				}
				fmt.Fprintln(os.Stderr, "")
			}

			// 3. Deploy edge functions
			if includeFunctions {
				fmt.Fprintln(os.Stderr, utils.Aqua(">>>")+" Deploying edge functions...")
				if err := deploy.Run(ctx, []string{}, true, nil, "", 1, false, fsys); err != nil && !errors.Is(err, function.ErrNoDeploy) {
					deployErrors = append(deployErrors, errors.Errorf("functions deploy failed: %w", err))
					fmt.Fprintln(os.Stderr, utils.Yellow("WARNING:")+" Functions deployment failed:", err)
				} else if errors.Is(err, function.ErrNoDeploy) {
					fmt.Fprintln(os.Stderr, utils.Yellow("⏭ ")+"No functions to deploy")
				} else {
					// print error just in case
					fmt.Fprintln(os.Stderr, err)
					fmt.Fprintln(os.Stderr, utils.Aqua("✓")+" Functions deployed successfully")
				}
				fmt.Fprintln(os.Stderr, "")
			}

			// Summary
			if len(deployErrors) > 0 {
				fmt.Fprintln(os.Stderr, utils.Yellow("Deploy completed with warnings:"))
				for _, err := range deployErrors {
					fmt.Fprintln(os.Stderr, " •", err)
				}
				return nil // Don't fail the command for non-critical errors
			}

			fmt.Fprintln(os.Stderr, utils.Aqua("✓")+" "+utils.Bold("Deployment completed successfully!"))
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

	// What to deploy - use direct Bool() since we check via cmd.Flags().Changed()
	cmdFlags.Bool("include-db", true, "Include database migrations (default: true)")
	cmdFlags.Bool("include-functions", true, "Include edge functions (default: true)")
	cmdFlags.Bool("include-config", true, "Include config.toml settings (default: true)")

	// DB push options (from db push command)
	cmdFlags.BoolVar(&deployDryRun, "dry-run", false, "Print operations that would be performed without executing them")
	cmdFlags.BoolVar(&deployIncludeAll, "include-all", false, "Include all migrations not found on remote history table")
	cmdFlags.BoolVar(&deployIncludeRoles, "include-roles", false, "Include custom roles from "+utils.CustomRolesPath)
	cmdFlags.BoolVar(&deployIncludeSeed, "include-seed", false, "Include seed data from your config")

	// Project config
	cmdFlags.String("db-url", "", "Deploys to the database specified by the connection string (must be percent-encoded)")
	cmdFlags.Bool("linked", true, "Deploys to the linked project")
	cmdFlags.Bool("local", false, "Deploys to the local database")
	deployCmd.MarkFlagsMutuallyExclusive("db-url", "linked", "local")
	cmdFlags.StringVarP(&dbPassword, "password", "p", "", "Password to your remote Postgres database")
	cobra.CheckErr(viper.BindPFlag("DB_PASSWORD", cmdFlags.Lookup("password")))
	cmdFlags.StringVar(&flags.ProjectRef, "project-ref", "", "Project ref of the Supabase project")

	rootCmd.AddCommand(deployCmd)
}
