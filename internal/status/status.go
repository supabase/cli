package status

import (
	"fmt"

	"github.com/supabase/cli/internal/utils"
)

func Run() error {
	// Sanity checks.
	if err := utils.AssertDockerIsRunning(); err != nil {
		return err
	}
	if err := utils.LoadConfig(); err != nil {
		return err
	}

    if err := utils.AssertSupabaseStartIsRunning(); err == nil {
        fmt.Println(utils.Aqua("supabase") + " local development setup is running.")
        utils.ShowStatus()
    } else {
        fmt.Println(utils.Aqua("supabase") + " local development setup is not running.")
    }

	return nil
}

