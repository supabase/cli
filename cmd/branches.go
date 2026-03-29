package cmd

import (
	"context"
	"fmt"
	"os"

	"github.com/go-errors/errors"
	"github.com/spf13/afero"
	"github.com/spf13/cobra"
	"github.com/supabase/cli/internal/branches/create"
	"github.com/supabase/cli/internal/branches/delete"
	"github.com/supabase/cli/internal/branches/disable"
	"github.com/supabase/cli/internal/branches/get"
	"github.com/supabase/cli/internal/branches/list"
	"github.com/supabase/cli/internal/branches/pause"
	"github.com/supabase/cli/internal/branches/unpause"
	"github.com/supabase/cli/internal/branches/update"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/internal/utils/flags"
	"github.com/supabase/cli/pkg/api"
	"github.com/supabase/cli/pkg/cast"
)

var (
	branchesCmd = &cobra.Command{
		GroupID: groupManagementAPI,
		Use:     "branches",
		Short:   "Manage Supabase preview branches",
	}

	persistent bool
	withData   bool
	notifyURL  string

	branchCreateCmd = &cobra.Command{
		Use:   "create [name]",
		Short: "Create a preview branch",
		Long:  "Create a preview branch for the linked project.",
		Args:  cobra.MaximumNArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			body := api.CreateBranchBody{IsDefault: cast.Ptr(false)}
			if len(args) > 0 {
				body.BranchName = args[0]
			}
			cmdFlags := cmd.Flags()
			if cmdFlags.Changed("region") {
				body.Region = &region.Value
			}
			if cmdFlags.Changed("size") {
				body.DesiredInstanceSize = (*api.CreateBranchBodyDesiredInstanceSize)(&size.Value)
			}
			if cmdFlags.Changed("persistent") {
				body.Persistent = &persistent
			}
			if cmdFlags.Changed("with-data") {
				body.WithData = &withData
			}
			if cmdFlags.Changed("notify-url") {
				body.NotifyUrl = &notifyURL
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
		Use:   "get [name]",
		Short: "Retrieve details of a preview branch",
		Long:  "Retrieve details of the specified preview branch.",
		Args:  cobra.MaximumNArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			ctx := cmd.Context()
			fsys := afero.NewOsFs()
			if len(args) > 0 {
				branchId = args[0]
			} else if err := promptBranchId(ctx, fsys); err != nil {
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
		Use:   "update [name]",
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
			if cmdFlags.Changed("notify-url") {
				body.NotifyUrl = &notifyURL
			}
			ctx := cmd.Context()
			fsys := afero.NewOsFs()
			if len(args) > 0 {
				branchId = args[0]
			} else if err := promptBranchId(ctx, fsys); err != nil {
				return err
			}
			return update.Run(cmd.Context(), branchId, body, fsys)
		},
	}

	branchPauseCmd = &cobra.Command{
		Use:   "pause [name]",
		Short: "Pause a preview branch",
		Args:  cobra.MaximumNArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			ctx := cmd.Context()
			fsys := afero.NewOsFs()
			if len(args) > 0 {
				branchId = args[0]
			} else if err := promptBranchId(ctx, fsys); err != nil {
				return err
			}
			return pause.Run(ctx, branchId)
		},
	}

	branchUnpauseCmd = &cobra.Command{
		Use:   "unpause [name]",
		Short: "Unpause a preview branch",
		Args:  cobra.MaximumNArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			ctx := cmd.Context()
			fsys := afero.NewOsFs()
			if len(args) > 0 {
				branchId = args[0]
			} else if err := promptBranchId(ctx, fsys); err != nil {
				return err
			}
			return unpause.Run(ctx, branchId)
		},
	}

	branchDeleteCmd = &cobra.Command{
		Use:   "delete [name]",
		Short: "Delete a preview branch",
		Long:  "Delete a preview branch by its name or ID.",
		Args:  cobra.MaximumNArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			ctx := cmd.Context()
			fsys := afero.NewOsFs()
			if len(args) > 0 {
				branchId = args[0]
			} else if err := promptBranchId(ctx, fsys); err != nil {
				return err
			}
			return delete.Run(ctx, branchId, nil)
		},
	}

	branchDisableCmd = &cobra.Command{
		Hidden: true,
		Use:    "disable",
		Short:  "Disable preview branching",
		Long:   "Disable preview branching for the linked project.",
		RunE: func(cmd *cobra.Command, args []string) error {
			return disable.Run(cmd.Context(), afero.NewOsFs())
		},
	}
)

func init() {
	branchFlags := branchesCmd.PersistentFlags()
	branchFlags.StringVar(&flags.ProjectRef, "project-ref", "", "Project ref of the Supabase project.")
	createFlags := branchCreateCmd.Flags()
	createFlags.Var(&region, "region", "Select a region to deploy the branch database.")
	createFlags.Var(&size, "size", "Select a desired instance size for the branch database.")
	createFlags.BoolVar(&persistent, "persistent", false, "Whether to create a persistent branch.")
	createFlags.BoolVar(&withData, "with-data", false, "Whether to clone production data to the branch database.")
	createFlags.StringVar(&notifyURL, "notify-url", "", "URL to notify when branch is active healthy.")
	branchesCmd.AddCommand(branchCreateCmd)
	branchesCmd.AddCommand(branchListCmd)
	branchesCmd.AddCommand(branchGetCmd)
	updateFlags := branchUpdateCmd.Flags()
	updateFlags.StringVar(&branchName, "name", "", "Rename the preview branch.")
	updateFlags.StringVar(&gitBranch, "git-branch", "", "Change the associated git branch.")
	updateFlags.BoolVar(&persistent, "persistent", false, "Switch between ephemeral and persistent branch.")
	updateFlags.Var(&branchStatus, "status", "Override the current branch status.")
	updateFlags.StringVar(&notifyURL, "notify-url", "", "URL to notify when branch is active healthy.")
	branchesCmd.AddCommand(branchUpdateCmd)
	branchesCmd.AddCommand(branchDeleteCmd)
	branchesCmd.AddCommand(branchDisableCmd)
	branchesCmd.AddCommand(branchPauseCmd)
	branchesCmd.AddCommand(branchUnpauseCmd)
	rootCmd.AddCommand(branchesCmd)
}

func promptBranchId(ctx context.Context, fsys afero.Fs) error {
	if console := utils.NewConsole(); !console.IsTTY {
		// Only read from stdin if the terminal is non-interactive
		title := "Enter the name of your branch"
		if branchId = utils.GetGitBranch(fsys); len(branchId) > 0 {
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
		return nil
	}
	branches, err := list.ListBranch(ctx, flags.ProjectRef)
	if err != nil {
		return err
	} else if len(branches) == 0 {
		utils.CmdSuggestion = fmt.Sprintf("Create your first branch with: %s", utils.Aqua("supabase branches create"))
		return errors.Errorf("branching is disabled")
	}
	// Let user choose from a list of branches
	items := make([]utils.PromptItem, len(branches))
	for i, branch := range branches {
		items[i] = utils.PromptItem{
			Summary: branch.Name,
			Details: branch.ProjectRef,
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
