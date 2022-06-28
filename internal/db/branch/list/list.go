package list

import (
	"errors"
	"fmt"
	"os"

	"github.com/supabase/cli/internal/utils"
)

func Run() error {
	branches, err := os.ReadDir(".supabase/branches")
	if errors.Is(err, os.ErrNotExist) {
		return nil
	} else if err != nil {
		return err
	}

	currBranch, err := utils.GetCurrentBranch()
	if err != nil {
		return err
	}

	for _, branch := range branches {
		if branch.Name() == "_current_branch" {
			continue
		}

		if branch.Name() == currBranch {
			fmt.Println("*", branch.Name())
		} else {
			fmt.Println(" ", branch.Name())
		}
	}

	return nil
}
