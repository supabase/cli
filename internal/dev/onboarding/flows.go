package onboarding

import (
	"context"
	"fmt"
	"os"

	"github.com/go-errors/errors"
	"github.com/spf13/afero"
	"github.com/supabase/cli/internal/db/pull"
	"github.com/supabase/cli/internal/functions/download"
	_init "github.com/supabase/cli/internal/init"
	"github.com/supabase/cli/internal/link"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/internal/utils/flags"
)

// LinkChoice represents user's choice about linking
type LinkChoice int

const (
	LinkChoiceYes LinkChoice = iota
	LinkChoiceNo
)

// RunInitFlow runs the project initialization
func RunInitFlow(ctx context.Context, fsys afero.Fs) error {
	params := utils.InitParams{}
	return _init.Run(ctx, fsys, true, params)
}

// PromptLinkChoice asks if user wants to link to remote project
func PromptLinkChoice(ctx context.Context) (LinkChoice, error) {
	items := []utils.PromptItem{
		{Summary: "Yes, link to existing project", Index: int(LinkChoiceYes)},
		{Summary: "No, I'm starting fresh", Index: int(LinkChoiceNo)},
	}

	choice, err := utils.PromptChoice(ctx, "Do you have a remote Supabase project to connect?", items)
	if err != nil {
		return LinkChoiceNo, err
	}

	return LinkChoice(choice.Index), nil
}

// RunLinkFlow prompts for project selection and links
func RunLinkFlow(ctx context.Context, fsys afero.Fs) error {
	// Use existing project selection from flags package
	if err := flags.PromptProjectRef(ctx, "Select a project to link:"); err != nil {
		return err
	}

	// Run link with selected project
	return link.Run(ctx, flags.ProjectRef, false, fsys)
}

// RunPullFlow pulls everything from the linked remote project:
// - Schema/migrations
// - Edge Functions
// - Storage config (via link, already done)
// - Auth config (via link, already done)
func RunPullFlow(ctx context.Context, fsys afero.Fs) error {
	projectRef := flags.ProjectRef
	if projectRef == "" {
		return errors.New("No project linked. Run 'supabase link' first.")
	}

	// Pull schema/migrations
	fmt.Fprintln(os.Stderr, "Pulling schema from remote database...")
	if err := pullSchema(ctx, fsys); err != nil {
		fmt.Fprintf(os.Stderr, "  %s Schema pull: %v\n", utils.Yellow("Warning:"), err)
	} else {
		fmt.Fprintln(os.Stderr, "  "+utils.Green("✓")+" Schema pulled")
	}

	// Pull Edge Functions
	fmt.Fprintln(os.Stderr, "Pulling Edge Functions...")
	if count, err := pullFunctions(ctx, fsys); err != nil {
		fmt.Fprintf(os.Stderr, "  %s Functions pull: %v\n", utils.Yellow("Warning:"), err)
	} else if count > 0 {
		fmt.Fprintf(os.Stderr, "  %s Edge Functions pulled (%d found)\n", utils.Green("✓"), count)
	} else {
		fmt.Fprintln(os.Stderr, "  "+utils.Green("✓")+" No Edge Functions found")
	}

	// Storage and Auth config are already synced during link.Run()
	fmt.Fprintln(os.Stderr, "  "+utils.Green("✓")+" Storage config synced")
	fmt.Fprintln(os.Stderr, "  "+utils.Green("✓")+" Auth config synced")

	return nil
}

// pullSchema pulls the database schema from remote
func pullSchema(ctx context.Context, fsys afero.Fs) error {
	// Get database config for connection
	config := flags.DbConfig

	// Run pull with default name
	return pull.Run(ctx, nil, config, "remote_schema", fsys)
}

// pullFunctions pulls all Edge Functions from remote
func pullFunctions(ctx context.Context, fsys afero.Fs) (int, error) {
	projectRef := flags.ProjectRef

	// List functions from remote
	resp, err := utils.GetSupabase().V1ListAllFunctionsWithResponse(ctx, projectRef)
	if err != nil {
		return 0, errors.Errorf("failed to list functions: %w", err)
	}
	if resp.JSON200 == nil {
		return 0, errors.Errorf("unexpected response: %s", string(resp.Body))
	}

	functions := *resp.JSON200
	if len(functions) == 0 {
		return 0, nil
	}

	// Download each function
	downloaded := 0
	for _, fn := range functions {
		fmt.Fprintf(os.Stderr, "    Downloading %s...\n", utils.Aqua(fn.Slug))
		// Use server-side unbundle (no Docker required)
		if err := download.Run(ctx, fn.Slug, projectRef, false, false, fsys); err != nil {
			fmt.Fprintf(os.Stderr, "    %s Failed to download %s: %v\n", utils.Yellow("Warning:"), fn.Slug, err)
			continue
		}
		downloaded++
	}

	return downloaded, nil
}
