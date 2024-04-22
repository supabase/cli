package cmd

import (
	"context"
	"fmt"
	"os"
	"sort"

	"github.com/go-errors/errors"
	"github.com/spf13/afero"
	"github.com/spf13/cobra"
	"github.com/supabase/cli/internal/branches/create"
	"github.com/supabase/cli/internal/branches/delete"
	"github.com/supabase/cli/internal/branches/disable"
	"github.com/supabase/cli/internal/branches/get"
	"github.com/supabase/cli/internal/branches/list"
	"github.com/supabase/cli/internal/branches/update"
	"github.com/supabase/cli/internal/gen/keys"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/internal/utils/flags"
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
			var name string
			if len(args) > 0 {
				name = args[0]
			}
			return create.Run(cmd.Context(), name, branchRegion.Value, afero.NewOsFs())
		},
	}

	branchListCmd = &cobra.Command{
		Use:   "list",
		Short: "List all preview branches",
		Long:  "List all preview branches of the linked project.",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			return list.Run(cmd.Context(), afero.NewOsFs())
		},
	}

	branchId string

	branchGetCmd = &cobra.Command{
		Use:   "get [branch-id]",
		Short: "Retrieve details of a preview branch",
		Long:  "Retrieve details of the specified preview branch.",
		Args:  cobra.MaximumNArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			ctx := cmd.Context()
			if len(args) == 0 {
				if err := promptBranchId(ctx, flags.ProjectRef); err != nil {
					return err
				}
			} else {
				branchId = args[0]
			}
			return get.Run(ctx, branchId)
		},
	}

	branchName  string
	gitBranch   string
	resetOnPush bool

	branchUpdateCmd = &cobra.Command{
		Use:   "update [branch-id]",
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
			if cmd.Flags().Changed("reset-on-push") {
				body.ResetOnPush = &resetOnPush
			}
			ctx := cmd.Context()
			if len(args) == 0 {
				if err := promptBranchId(ctx, flags.ProjectRef); err != nil {
					return err
				}
			} else {
				branchId = args[0]
			}
			return update.Run(cmd.Context(), branchId, body, afero.NewOsFs())
		},
	}

	branchDeleteCmd = &cobra.Command{
		Use:   "delete [branch-id]",
		Short: "Delete a preview branch",
		Long:  "Delete a preview branch by its ID.",
		Args:  cobra.MaximumNArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			ctx := cmd.Context()
			if len(args) == 0 {
				if err := promptBranchId(ctx, flags.ProjectRef); err != nil {
					return err
				}
			} else {
				branchId = args[0]
			}
			return delete.Run(ctx, branchId)
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
	branchFlags := branchesCmd.PersistentFlags()
	branchFlags.StringVar(&flags.ProjectRef, "project-ref", "", "Project ref of the Supabase project.")
	// Setup enum flags
	i := 0
	for k := range utils.FlyRegions {
		branchRegion.Allowed[i] = k
		i++
	}
	sort.Strings(branchRegion.Allowed)
	createFlags := branchCreateCmd.Flags()
	createFlags.Var(&branchRegion, "region", "Select a region to deploy the branch database.")
	branchesCmd.AddCommand(branchCreateCmd)
	branchesCmd.AddCommand(branchListCmd)
	branchesCmd.AddCommand(branchGetCmd)
	updateFlags := branchUpdateCmd.Flags()
	updateFlags.StringVar(&branchName, "name", "", "Rename the preview branch.")
	updateFlags.StringVar(&gitBranch, "git-branch", "", "Change the associated git branch.")
	updateFlags.BoolVar(&resetOnPush, "reset-on-push", false, "Reset the preview branch on git push.")
	branchesCmd.AddCommand(branchUpdateCmd)
	branchesCmd.AddCommand(branchDeleteCmd)
	branchesCmd.AddCommand(branchDisableCmd)
	rootCmd.AddCommand(branchesCmd)
}

func promptBranchId(ctx context.Context, ref string) error {
	resp, err := utils.GetSupabase().GetBranchesWithResponse(ctx, ref)
	if err != nil {
		return errors.Errorf("failed to list preview branches: %w", err)
	}
	if resp.JSON200 == nil {
		return errors.New("Unexpected error listing preview branches: " + string(resp.Body))
	}
	console := utils.NewConsole()
	if !console.IsTTY {
		// Fallback to current git branch on GHA
		gitBranch := keys.GetGitBranch(afero.NewOsFs())
		title := "Enter the name of your branch: "
		if len(gitBranch) > 0 {
			title = fmt.Sprintf("%-2s (or leave blank to use %s): ", title, utils.Aqua(gitBranch))
		}
		if name, err := console.PromptText(title); err != nil {
			return err
		} else if len(name) > 0 {
			gitBranch = name
		}
		for _, branch := range *resp.JSON200 {
			if branch.Name == gitBranch {
				branchId = branch.Id
				return nil
			}
		}
		return errors.Errorf("Branch not found: %s", gitBranch)
	}
	items := make([]utils.PromptItem, len(*resp.JSON200))
	for i, branch := range *resp.JSON200 {
		items[i] = utils.PromptItem{
			Summary: branch.Name,
			Details: branch.Id,
		}
	}
	title := "Select a branch:"
	choice, err := utils.PromptChoice(ctx, title, items)
	if err == nil {
		branchId = choice.Details
		fmt.Fprintln(os.Stderr, "Selected branch ID:", branchId)
	}
	return err
}
