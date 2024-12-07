package cmd

import (
	"os"
	"sort"

	"github.com/spf13/afero"
	"github.com/spf13/cobra"
	"github.com/spf13/viper"
	"github.com/supabase/cli/internal/projects/apiKeys"
	"github.com/supabase/cli/internal/projects/create"
	"github.com/supabase/cli/internal/projects/delete"
	"github.com/supabase/cli/internal/projects/list"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/internal/utils/flags"
	"github.com/supabase/cli/pkg/api"
	"golang.org/x/term"
)

var (
	projectsCmd = &cobra.Command{
		GroupID: groupManagementAPI,
		Use:     "projects",
		Short:   "Manage Supabase projects",
	}

	interactive bool
	projectName string
	orgId       string
	dbPassword  string

	region = utils.EnumFlag{
		Allowed: awsRegions(),
	}
	plan = utils.EnumFlag{
		Allowed: []string{string(api.V1CreateProjectBodyDtoPlanFree), string(api.V1CreateProjectBodyDtoPlanPro)},
		Value:   string(api.V1CreateProjectBodyDtoPlanFree),
	}
	size = utils.EnumFlag{
		Allowed: []string{
			string(api.DesiredInstanceSizeMicro),
			string(api.DesiredInstanceSizeSmall),
			string(api.DesiredInstanceSizeMedium),
			string(api.DesiredInstanceSizeLarge),
			string(api.DesiredInstanceSizeXlarge),
			string(api.DesiredInstanceSizeN2xlarge),
			string(api.DesiredInstanceSizeN4xlarge),
			string(api.DesiredInstanceSizeN8xlarge),
			string(api.DesiredInstanceSizeN12xlarge),
			string(api.DesiredInstanceSizeN16xlarge),
		},
	}

	projectsCreateCmd = &cobra.Command{
		Use:     "create [project name]",
		Short:   "Create a project on Supabase",
		Args:    cobra.MaximumNArgs(1),
		Example: `supabase projects create my-project --org-id cool-green-pqdr0qc --db-password ******** --region us-east-1`,
		PreRunE: func(cmd *cobra.Command, args []string) error {
			if !term.IsTerminal(int(os.Stdin.Fd())) || !interactive {
				cobra.CheckErr(cmd.MarkFlagRequired("org-id"))
				cobra.CheckErr(cmd.MarkFlagRequired("db-password"))
				cobra.CheckErr(cmd.MarkFlagRequired("region"))
				return cobra.ExactArgs(1)(cmd, args)
			}
			return nil
		},
		RunE: func(cmd *cobra.Command, args []string) error {
			if len(args) > 0 {
				projectName = args[0]
			}
			body := api.V1CreateProjectBodyDto{
				Name:           projectName,
				OrganizationId: orgId,
				DbPass:         dbPassword,
				Region:         api.V1CreateProjectBodyDtoRegion(region.Value),
			}
			if cmd.Flags().Changed("size") {
				body.DesiredInstanceSize = (*api.V1CreateProjectBodyDtoDesiredInstanceSize)(&size.Value)
			}
			return create.Run(cmd.Context(), body, afero.NewOsFs())
		},
	}

	projectsListCmd = &cobra.Command{
		Use:   "list",
		Short: "List all Supabase projects",
		Long:  "List all Supabase projects the logged-in user can access.",
		RunE: func(cmd *cobra.Command, args []string) error {
			return list.Run(cmd.Context(), afero.NewOsFs())
		},
	}

	projectsApiKeysCmd = &cobra.Command{
		Use:   "api-keys",
		Short: "List all API keys for a Supabase project",
		RunE: func(cmd *cobra.Command, args []string) error {
			return apiKeys.Run(cmd.Context(), flags.ProjectRef, afero.NewOsFs())
		},
	}

	projectsDeleteCmd = &cobra.Command{
		Use:   "delete <ref>",
		Short: "Delete a Supabase project",
		Args:  cobra.MaximumNArgs(1),
		PreRunE: func(cmd *cobra.Command, args []string) error {
			if !term.IsTerminal(int(os.Stdin.Fd())) {
				return cobra.ExactArgs(1)(cmd, args)
			}
			return nil
		},
		RunE: func(cmd *cobra.Command, args []string) error {
			ctx := cmd.Context()
			if len(args) == 0 {
				title := "Which project do you want to delete?"
				cobra.CheckErr(flags.PromptProjectRef(ctx, title))
			} else {
				flags.ProjectRef = args[0]
			}
			if err := delete.PreRun(ctx, flags.ProjectRef); err != nil {
				return err
			}
			return delete.Run(ctx, flags.ProjectRef, afero.NewOsFs())
		},
	}
)

func init() {
	// Add flags to cobra command
	createFlags := projectsCreateCmd.Flags()
	createFlags.BoolVarP(&interactive, "interactive", "i", true, "Enables interactive mode.")
	cobra.CheckErr(createFlags.MarkHidden("interactive"))
	createFlags.StringVar(&orgId, "org-id", "", "Organization ID to create the project in.")
	createFlags.StringVar(&dbPassword, "db-password", "", "Database password of the project.")
	createFlags.Var(&region, "region", "Select a region close to you for the best performance.")
	createFlags.Var(&plan, "plan", "Select a plan that suits your needs.")
	cobra.CheckErr(createFlags.MarkHidden("plan"))
	createFlags.Var(&size, "size", "Select a desired instance size for your project.")
	cobra.CheckErr(viper.BindPFlag("DB_PASSWORD", createFlags.Lookup("db-password")))

	apiKeysFlags := projectsApiKeysCmd.Flags()
	apiKeysFlags.StringVar(&flags.ProjectRef, "project-ref", "", "Project ref of the Supabase project.")

	// Add commands to root
	projectsCmd.AddCommand(projectsCreateCmd)
	projectsCmd.AddCommand(projectsDeleteCmd)
	projectsCmd.AddCommand(projectsListCmd)
	projectsCmd.AddCommand(projectsApiKeysCmd)
	rootCmd.AddCommand(projectsCmd)
}

func awsRegions() []string {
	result := make([]string, len(utils.RegionMap))
	i := 0
	for k := range utils.RegionMap {
		result[i] = k
		i++
	}
	sort.Strings(result)
	return result
}
