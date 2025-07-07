package cmd

import (
	"context"
	"fmt"
	"os"

	"github.com/go-errors/errors"
	"github.com/google/uuid"
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
		Allowed: awsRegions(),
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
				body.DesiredInstanceSize = (*api.CreateBranchBodyDesiredInstanceSize)(&size.Value)
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
			fsys := afero.NewOsFs()
			if err := promptBranchId(ctx, args, fsys); err != nil {
				return err
			}
			return get.Run(ctx, branchId, fsys)
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
	branchName string
	gitBranch  string

	branchUpdateCmd = &cobra.Command{
		Use:   "update [branch-id]",
		Short: "Update a preview branch",
		Long:  "Update a preview branch by its name or ID.",
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
			if cmdFlags.Changed("persistent") {
				body.Persistent = &persistent
			}
			if cmdFlags.Changed("status") {
				body.Status = (*api.UpdateBranchBodyStatus)(&branchStatus.Value)
			}
			ctx := cmd.Context()
			fsys := afero.NewOsFs()
			if err := promptBranchId(ctx, args, fsys); err != nil {
				return err
			}
			return update.Run(cmd.Context(), branchId, body, fsys)
		},
	}

	branchDeleteCmd = &cobra.Command{
		Use:   "delete [branch-id]",
		Short: "Delete a preview branch",
		Long:  "Delete a preview branch by its name or ID.",
		Args:  cobra.MaximumNArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			ctx := cmd.Context()
			fsys := afero.NewOsFs()
			if err := promptBranchId(ctx, args, fsys); err != nil {
				return err
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
	updateFlags.BoolVar(&persistent, "persistent", false, "Switch between ephemeral and persistent branch.")
	updateFlags.Var(&branchStatus, "status", "Override the current branch status.")
	branchesCmd.AddCommand(branchUpdateCmd)
	branchesCmd.AddCommand(branchDeleteCmd)
	branchesCmd.AddCommand(branchDisableCmd)
	rootCmd.AddCommand(branchesCmd)
}

func promptBranchId(ctx context.Context, args []string, fsys afero.Fs) error {
	var filter []list.BranchFilter
	if len(args) > 0 {
		if branchId = args[0]; uuid.Validate(branchId) == nil {
			return nil
		}
		// Try resolving as branch name
		filter = append(filter, list.FilterByName(branchId))
	} else if console := utils.NewConsole(); !console.IsTTY {
		// Only read from stdin if the terminal is non-interactive
		title := "Enter the name of your branch"
		if branchId = keys.GetGitBranch(fsys); len(branchId) > 0 {
			title += fmt.Sprintf(" (or leave blank to use %s)", utils.Aqua(branchId))
		}
		title += ": "
		if name, err := console.PromptText(ctx, title); err != nil {
			return err
		} else if len(name) > 0 {
			branchId = name
		}
		if len(branchId) == 0 {
			return errors.New("branch name cannot be empty")
		}
		filter = append(filter, list.FilterByName(branchId))
	}
	branches, err := list.ListBranch(ctx, flags.ProjectRef, filter...)
	if err != nil {
		return err
	} else if len(branches) == 0 {
		return errors.Errorf("branch not found: %s", branchId)
	} else if len(branches) == 1 {
		branchId = branches[0].Id.String()
		return nil
	}
	// Let user choose from a list of branches
	items := make([]utils.PromptItem, len(branches))
	for i, branch := range branches {
		items[i] = utils.PromptItem{
			Summary: branch.Name,
			Details: branch.Id.String(),
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
