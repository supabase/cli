package status

import (
	"context"
	"fmt"

	"github.com/supabase/cli/internal/utils"
)

var ctx = context.Background()

func Run() error {
	// Sanity checks.
	if err := utils.AssertDockerIsRunning(); err != nil {
		return err
	}
	if err := utils.LoadConfig(); err != nil {
		return err
	}

	// check containers status.
	{
		containers, err := utils.GetProjectContainers(ctx)
		if err != nil {
			return err
		}

		allStopped := true
		status := utils.Red("Stopped")

		for _, container := range containers {
			if allStopped && container.State == "running" {
				allStopped = false
				status = utils.Aqua("Running")
				break
			}
		}

		fmt.Println(fmt.Sprintf("Supabase local development: %s", utils.Bold(status)))
	}

	return nil
}
