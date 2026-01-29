package onboarding

import (
	"context"

	"github.com/supabase/cli/internal/utils"
)

// ConflictAction represents how to handle local/remote conflicts
type ConflictAction int

const (
	ConflictMerge     ConflictAction = iota // Pull remote, keep local migrations
	ConflictReplace                         // Replace local with remote
	ConflictKeepLocal                       // Skip pull, keep local
)

// PromptConflictResolution asks user how to handle conflicts between local and remote
func PromptConflictResolution(ctx context.Context) (ConflictAction, error) {
	items := []utils.PromptItem{
		{
			Summary: "Pull remote schema as new migration",
			Details: "keeps existing local migrations",
			Index:   int(ConflictMerge),
		},
		{
			Summary: "Replace local migrations with remote",
			Details: "removes existing local migrations",
			Index:   int(ConflictReplace),
		},
		{
			Summary: "Keep local, skip remote pull",
			Details: "no changes to local files",
			Index:   int(ConflictKeepLocal),
		},
	}

	choice, err := utils.PromptChoice(ctx, "Local migrations already exist. How would you like to handle the remote schema?", items)
	if err != nil {
		return ConflictKeepLocal, err
	}

	return ConflictAction(choice.Index), nil
}
