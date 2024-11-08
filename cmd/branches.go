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
		Allowed: flyRegions(),
	}
	persistent bool

	branchCreateCmd = &cobra.Command{
		Use:   "create [name]",
		Short: "Create a preview branch",
		Long:  "Create a preview branch for the linked project.",
		Args:  cobra.MaximumNArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			var body api.CreateBranchBody
			if len(args) > 0 {
				body.BranchName = args[0]
			}
			cmdFlags := cmd.Flags()
			if cmdFlags.Changed("region") {
				body.Region = &branchRegion.Value
			}
			if cmdFlags.Changed("size") {
				body.DesiredInstanceSize = (*api.DesiredInstanceSize)(&size.Value)
			}
			if cmdFlags.Changed("persistent") {
				body.Persistent = &persistent
			}
			return create.Run(cmd.Context(), body, afero.NewOsFs())
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

	branchStatus = utils.EnumFlag{
		Allowed: []string{
			string(api.BranchResponseStatusRUNNINGMIGRATIONS),
			string(api.BranchResponseStatusMIGRATIONSPASSED),
			string(api.BranchResponseStatusMIGRATIONSFAILED),
			string(api.BranchResponseStatusFUNCTIONSDEPLOYED),
			string(api.BranchResponseStatusFUNCTIONSFAILED),
		},
	}
	branchName  string
	gitBranch   string
	resetOnPush bool

	branchUpdateCmd = &cobra.Command{
		Use:   "update [branch-id]",
		Short: "Update a preview branch",
		Long:  "Update a preview branch by its ID.",
		Args:  cobra.MaximumNArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			cmdFlags := cmd.Flags()
			var body api.UpdateBranchBody
			if cmdFlags.Changed("name") {
				body.BranchName = &branchName
			}
			if cmdFlags.Changed("git-branch") {
				body.GitBranch = &gitBranch
			}
			if cmdFlags.Changed("reset-on-push") {
				body.ResetOnPush = &resetOnPush
			}
			if cmdFlags.Changed("persistent") {
				body.Persistent = &persistent
			}
			if cmdFlags.Changed("status") {
				body.Status = (*api.UpdateBranchBodyStatus)(&branchStatus.Value)
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
	createFlags := branchCreateCmd.Flags()
	createFlags.Var(&branchRegion, "region", "Select a region to deploy the branch database.")
	createFlags.Var(&size, "size", "Select a desired instance size for the branch database.")
	createFlags.BoolVar(&persistent, "persistent", false, "Whether to create a persistent branch.")
	branchesCmd.AddCommand(branchCreateCmd)
	branchesCmd.AddCommand(branchListCmd)
	branchesCmd.AddCommand(branchGetCmd)
	updateFlags := branchUpdateCmd.Flags()
	updateFlags.StringVar(&branchName, "name", "", "Rename the preview branch.")
	updateFlags.StringVar(&gitBranch, "git-branch", "", "Change the associated git branch.")
	updateFlags.BoolVar(&resetOnPush, "reset-on-push", false, "Reset the preview branch on git push.")
	updateFlags.BoolVar(&persistent, "persistent", false, "Switch between ephemeral and persistent branch.")
	updateFlags.Var(&branchStatus, "status", "Override the current branch status.")
	branchesCmd.AddCommand(branchUpdateCmd)
	branchesCmd.AddCommand(branchDeleteCmd)
	branchesCmd.AddCommand(branchDisableCmd)
	rootCmd.AddCommand(branchesCmd)
}

func flyRegions() []string {
	result := make([]string, len(utils.FlyRegions))
	i := 0
	for k := range utils.FlyRegions {
		result[i] = k
		i++
	}
	sort.Strings(result)
	return result
}

func promptBranchId(ctx context.Context, ref string) error {
	resp, err := utils.GetSupabase().V1ListAllBranchesWithResponse(ctx, ref)
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
		if name, err := console.PromptText(ctx, title); err != nil {
			return err
		} else if len(name) > 0 {
			gitBranch = name
		}
		if len(gitBranch) == 0 {
			return errors.New("git branch cannot be empty")
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
