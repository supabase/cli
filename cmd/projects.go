package cmd

import (
	"errors"
	"fmt"
	"os"
	"sort"
	"strings"

	"github.com/spf13/afero"
	"github.com/spf13/cobra"
	"github.com/spf13/viper"
	"github.com/supabase/cli/internal/link"
	"github.com/supabase/cli/internal/projects/create"
	"github.com/supabase/cli/internal/projects/list"
	"github.com/supabase/cli/internal/projects/apiKeys"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/pkg/api"
	"github.com/supabase/cli/internal/utils/flags"
)

var (
	projectsCmd = &cobra.Command{
		GroupID: groupManagementAPI,
		Use:     "projects",
		Short:   "Manage Supabase projects",
	}

	interactive bool
	orgId       string
	dbPassword  string

	region = utils.EnumFlag{
		Allowed: make([]string, len(utils.RegionMap)),
	}
	plan = utils.EnumFlag{
		Allowed: []string{string(api.Free), string(api.Pro)},
		Value:   string(api.Free),
	}

	projectsCreateCmd = &cobra.Command{
		Use:     "create <project name>",
		Short:   "Create a project on Supabase",
		Args:    cobra.ExactArgs(1),
		Example: `supabase projects create my-project --org-id cool-green-pqdr0qc --db-password ******** --region us-east-1`,
		PreRun: func(cmd *cobra.Command, args []string) {
			if !interactive {
				cobra.CheckErr(cmd.MarkFlagRequired("org-id"))
				cobra.CheckErr(cmd.MarkFlagRequired("db-password"))
				cobra.CheckErr(cmd.MarkFlagRequired("region"))
			}
		},
		RunE: func(cmd *cobra.Command, args []string) error {
			name := args[0]
			if interactive {
				fmt.Fprintln(os.Stderr, printKeyValue("Creating project", name))
				cobra.CheckErr(PromptCreateFlags(cmd))
			}
			return create.Run(cmd.Context(), api.CreateProjectBody{
				Name:           name,
				OrganizationId: orgId,
				DbPass:         dbPassword,
				Region:         api.CreateProjectBodyRegion(region.Value),
				Plan:           api.CreateProjectBodyPlan(plan.Value),
			}, afero.NewOsFs())
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
		Short: "List all api-keys for a Supabase project",
		Long:  "List all api-keys for a Supabase project the logged-in user can access.",
		RunE: func(cmd *cobra.Command, args []string) error {
			return apiKeys.Run(cmd.Context(), flags.ProjectRef, afero.NewOsFs())
		},
	}
)

func init() {
	// Setup enum flags
	i := 0
	for k := range utils.RegionMap {
		region.Allowed[i] = k
		i++
	}
	sort.Strings(region.Allowed)
	// Add flags to cobra command
	createFlags := projectsCreateCmd.Flags()
	createFlags.BoolVarP(&interactive, "interactive", "i", false, "Enables interactive mode.")
	createFlags.StringVar(&orgId, "org-id", "", "Organization ID to create the project in.")
	createFlags.StringVar(&dbPassword, "db-password", "", "Database password of the project.")
	createFlags.Var(&region, "region", "Select a region close to you for the best performance.")
	createFlags.Var(&plan, "plan", "Select a plan that suits your needs.")
	cobra.CheckErr(viper.BindPFlag("DB_PASSWORD", createFlags.Lookup("db-password")))

	apiKeysFlags := projectsApiKeysCmd.Flags()
	apiKeysFlags.StringVar(&flags.ProjectRef, "project-ref", "", "Project ref of the Supabase project.")

	// Add commands to root
	projectsCmd.AddCommand(projectsCreateCmd)
	projectsCmd.AddCommand(projectsListCmd)
	projectsCmd.AddCommand(projectsApiKeysCmd)
	rootCmd.AddCommand(projectsCmd)
}

func PromptCreateFlags(cmd *cobra.Command) error {
	ctx := cmd.Context()
	if !cmd.Flags().Changed("org-id") {
		title := "Which organisation do you want to create the project for?"
		resp, err := utils.GetSupabase().GetOrganizationsWithResponse(ctx)
		if err != nil {
			return err
		}
		if resp.JSON200 == nil {
			return errors.New("Unexpected error retrieving organizations: " + string(resp.Body))
		}
		items := make([]utils.PromptItem, len(*resp.JSON200))
		for i, org := range *resp.JSON200 {
			items[i] = utils.PromptItem{Summary: org.Name, Details: org.Id}
		}
		choice, err := utils.PromptChoice(ctx, title, items)
		if err != nil {
			return err
		}
		orgId = choice.Details
	}
	fmt.Fprintln(os.Stderr, printKeyValue("Selected org-id", orgId))
	if !cmd.Flags().Changed("region") {
		title := "Which region do you want to host the project in?"
		items := make([]utils.PromptItem, len(utils.RegionMap))
		i := 0
		for k, v := range utils.RegionMap {
			items[i] = utils.PromptItem{Summary: k, Details: v}
			i++
		}
		choice, err := utils.PromptChoice(ctx, title, items)
		if err != nil {
			return err
		}
		region.Value = choice.Summary
	}
	fmt.Fprintln(os.Stderr, printKeyValue("Selected region", region.Value))
	if !cmd.Flags().Changed("plan") {
		title := "Do you want a free or pro plan?"
		choice, err := utils.PromptChoice(ctx, title, []utils.PromptItem{
			{Summary: string(api.Free)},
			{Summary: string(api.Pro)},
		})
		if err != nil {
			return err
		}
		plan.Value = choice.Summary
	}
	fmt.Fprintln(os.Stderr, printKeyValue("Selected plan", plan.Value))
	if dbPassword == "" {
		dbPassword = link.PromptPassword(os.Stdin)
	}
	return nil
}

func printKeyValue(key, value string) string {
	indent := 20 - len(key)
	spaces := strings.Repeat(" ", indent)
	return key + ":" + spaces + value
}
