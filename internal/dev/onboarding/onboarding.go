package onboarding

import (
	"context"
	"fmt"
	"os"

	"github.com/go-errors/errors"
	"github.com/spf13/afero"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/internal/utils/flags"
)

// State represents the current project setup state
type State struct {
	ConfigExists  bool // supabase/config.toml exists
	ProjectLinked bool // .temp/project-ref exists
	HasMigrations bool // migrations/*.sql exist
	HasFunctions  bool // functions/* exist
}

// Options configures onboarding behavior
type Options struct {
	Interactive bool
}

// Result contains the outcome of onboarding
type Result struct {
	JustInitialized bool // Whether we just ran init
	JustLinked      bool // Whether we just ran link
}

// Run executes the onboarding flow based on current state
// Returns a Result indicating what actions were taken
func Run(ctx context.Context, fsys afero.Fs, opts Options) (*Result, error) {
	result := &Result{}

	// Step 1: Detect current state
	state := DetectState(fsys)

	// Step 2: Init if needed
	if !state.ConfigExists {
		if !opts.Interactive {
			return nil, errors.New("No Supabase project found. Run 'supabase init' first or use 'supabase dev' interactively.")
		}

		fmt.Fprintln(os.Stderr, utils.Bold("No Supabase project found. Let's set one up!"))
		fmt.Fprintln(os.Stderr)

		if err := RunInitFlow(ctx, fsys); err != nil {
			return nil, err
		}

		result.JustInitialized = true
		fmt.Fprintln(os.Stderr)
		fmt.Fprintln(os.Stderr, "Finished "+utils.Aqua("supabase init")+".")
		fmt.Fprintln(os.Stderr)
	}

	// Reload config after potential init
	if err := flags.LoadConfig(fsys); err != nil {
		return nil, err
	}

	// Step 3: Offer to link ONLY after fresh init (not on every run)
	// Re-detect state since we may have just initialized
	state = DetectState(fsys)

	if !state.ProjectLinked && opts.Interactive && result.JustInitialized {
		choice, err := PromptLinkChoice(ctx)
		if err != nil {
			return nil, err
		}

		if choice == LinkChoiceYes {
			if err := RunLinkFlow(ctx, fsys); err != nil {
				return nil, err
			}
			result.JustLinked = true

			// Step 4: Pull everything from remote after linking
			fmt.Fprintln(os.Stderr)
			fmt.Fprintln(os.Stderr, utils.Bold("Pulling from remote project..."))
			fmt.Fprintln(os.Stderr)

			// Detect conflicts before pulling
			if state.HasMigrations {
				action, err := PromptConflictResolution(ctx)
				if err != nil {
					return nil, err
				}

				switch action {
				case ConflictKeepLocal:
					fmt.Fprintln(os.Stderr, "Keeping local migrations, skipping remote pull.")
					return result, nil
				case ConflictReplace:
					// TODO: Clear local migrations before pulling
					fmt.Fprintln(os.Stderr, "Replacing local migrations with remote schema.")
				case ConflictMerge:
					fmt.Fprintln(os.Stderr, "Pulling remote schema as new migration.")
				}
			}

			if err := RunPullFlow(ctx, fsys); err != nil {
				// Log warning but continue - partial setup is better than failure
				fmt.Fprintf(os.Stderr, "%s Failed to pull from remote: %v\n", utils.Yellow("Warning:"), err)
			}
		}
	}

	return result, nil
}
