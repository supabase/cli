package cmd

import (
	"github.com/spf13/afero"
	"github.com/spf13/cobra"
	"github.com/supabase/cli/internal/projects/create"
	"github.com/supabase/cli/internal/projects/list"
)

var (
	projectsCmd = &cobra.Command{
		Use:   "projects",
		Short: "Manage Supabase projects",
	}

	projectsCreateCmd = &cobra.Command{
		Use:     "create",
		Short:   "Create a new project.",
		Args:    cobra.ExactArgs(1),
		Example: `supabase projects create my-project --org-id cool-green-pqdr0qc --db-password ******** --region us-east-1`,
		RunE: func(cmd *cobra.Command, args []string) error {
			name := args[0]
			orgId, err := cmd.Flags().GetString("org-id")
			if err != nil {
				return err
			}
			dbPassword, err := cmd.Flags().GetString("db-password")
			if err != nil {
				return err
			}
			region, err := cmd.Flags().GetString("region")
			if err != nil {
				return err
			}
			plan, err := cmd.Flags().GetString("plan")
			if err != nil {
				return err
			}

			return create.Run(create.RequestParam{
				Name:   name,
				OrgId:  orgId,
				DbPass: dbPassword,
				Region: region,
				Plan:   plan,
			}, afero.NewOsFs())
		},
	}

	projectsListCmd = &cobra.Command{
		Use:   "list",
		Short: "List all projects.",
		RunE: func(cmd *cobra.Command, args []string) error {
			return list.Run(afero.NewOsFs())
		},
	}
)

func init() {
	// TODO: Make these optional once we implement prompting missing flags.
	projectsCreateCmd.Flags().String("org-id", "", "Organization ID to create the project in.")
	if err := projectsCreateCmd.MarkFlagRequired("org-id"); err != nil {
		panic(err)
	}
	projectsCreateCmd.Flags().String("db-password", "", "Database password of the project.")
	if err := projectsCreateCmd.MarkFlagRequired("db-password"); err != nil {
		panic(err)
	}
	projectsCreateCmd.Flags().String("region", "", "Select a region close to you for the best performance.")
	if err := projectsCreateCmd.MarkFlagRequired("region"); err != nil {
		panic(err)
	}
	projectsCreateCmd.Flags().String("plan", "free", `Select a plan that suits your needs. Can be "free" or "pro".`)
	projectsCmd.AddCommand(projectsCreateCmd)
	projectsCmd.AddCommand(projectsListCmd)
	rootCmd.AddCommand(projectsCmd)
}
