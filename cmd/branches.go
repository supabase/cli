package cmd

import (
	"sort"

	"github.com/spf13/afero"
	"github.com/spf13/cobra"
	"github.com/supabase/cli/internal/branches/create"
	"github.com/supabase/cli/internal/branches/delete"
	"github.com/supabase/cli/internal/branches/disable"
	"github.com/supabase/cli/internal/branches/get"
	"github.com/supabase/cli/internal/branches/list"
	"github.com/supabase/cli/internal/branches/update"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/pkg/api"
)

var (
	branchesCmd = &cobra.Command{
		GroupID: groupManagementAPI,
		Use:     "branches",
		Short:   "Manage Supabase preview branches",
	}

	branchRegion = utils.EnumFlag{
		Allowed: make([]string, len(utils.FlyRegions)),
	}

	branchCreateCmd = &cobra.Command{
		Use:   "create [name]",
		Short: "Create a preview branch",
		Long:  "Create a preview branch for the linked project.",
		Args:  cobra.MaximumNArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			return create.Run(cmd.Context(), args[0], branchRegion.Value, afero.NewOsFs())
		},
	}

	branchListCmd = &cobra.Command{
		Use:   "list",
		Short: "List all preview branches",
		Long:  "List all preview branches of the linked project.",
		RunE: func(cmd *cobra.Command, args []string) error {
			return list.Run(cmd.Context(), afero.NewOsFs())
		},
	}

	branchGetCmd = &cobra.Command{
		Use:   "get <branch-id>",
		Short: "Retrieve details of a preview branch",
		Long:  "Retrieve details of the specified preview branch.",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			return get.Run(cmd.Context(), args[0])
		},
	}

	branchName string
	gitBranch  string

	branchUpdateCmd = &cobra.Command{
		Use:   "update <branch-id>",
		Short: "Update a preview branch",
		Long:  "Update a preview branch by its ID.",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			var body api.UpdateBranchBody
			if cmd.Flags().Changed("name") {
				body.BranchName = &branchName
			}
			if cmd.Flags().Changed("git-branch") {
				body.GitBranch = &gitBranch
			}
			return update.Run(cmd.Context(), args[0], body, afero.NewOsFs())
		},
	}

	branchDeleteCmd = &cobra.Command{
		Use:   "delete <branch-id>",
		Short: "Delete a preview branch",
		Long:  "Delete a preview branch by its ID.",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			return delete.Run(cmd.Context(), args[0])
		},
	}

	branchDisableCmd = &cobra.Command{
		Use:   "disable",
		Short: "Disable preview branching",
		Long:  "Disable preview branching for the linked project.",
		RunE: func(cmd *cobra.Command, args []string) error {
			return disable.Run(cmd.Context(), afero.NewOsFs())
		},
	}
)

func init() {
	branchesCmd.AddCommand(branchCreateCmd)
	// Setup enum flags
	i := 0
	for k := range utils.FlyRegions {
		branchRegion.Allowed[i] = k
		i++
	}
	sort.Strings(branchRegion.Allowed)
	createFlags := branchCreateCmd.Flags()
	createFlags.Var(&branchRegion, "region", "Select a region to deploy the branch database.")
	branchesCmd.AddCommand(branchListCmd)
	branchesCmd.AddCommand(branchGetCmd)
	updateFlags := branchUpdateCmd.Flags()
	updateFlags.StringVar(&branchName, "name", "", "Rename the preview branch.")
	updateFlags.StringVar(&gitBranch, "git-branch", "", "Change the associated git branch.")
	branchesCmd.AddCommand(branchUpdateCmd)
	branchesCmd.AddCommand(branchDeleteCmd)
	branchesCmd.AddCommand(branchDisableCmd)
	rootCmd.AddCommand(branchesCmd)
}
