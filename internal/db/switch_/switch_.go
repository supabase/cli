package switch_

import (
	"errors"
	"fmt"
	"os"

	"github.com/supabase/cli/internal/utils"
)

func Run(target string) error {
	utils.AssertSupabaseStartIsRunning()

	branches, err := os.ReadDir("supabase/.branches")
	if errors.Is(err, os.ErrNotExist) {
		return errors.New("Branch " + target + " does not exist.")
	}

	for _, branch := range branches {
		if branch.Name() == "_current_branch" {
			continue
		}

		if branch.Name() == target {
			if err := os.WriteFile("supabase/.branches/_current_branch", []byte(target), 0644); err != nil {
				return err
			}

			fmt.Println("Switched to branch " + target + ".")
			return nil
		}
	}

	return errors.New("Branch " + target + " does not exist.")
}
