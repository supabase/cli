package status

import (
	"context"
	"fmt"
	"strings"

	"github.com/docker/docker/api/types"
	"github.com/docker/docker/api/types/filters"
	"github.com/supabase/cli/internal/utils"
)

var ctx = context.Background()

func Run(useShortId bool) error {
	// Sanity checks.
	if err := utils.AssertDockerIsRunning(); err != nil {
		return err
	}
	if err := utils.LoadConfig(); err != nil {
		return err
	}

	// List containers.
	{
		containers, err := utils.Docker.ContainerList(ctx, types.ContainerListOptions{
			All:     true,
			Filters: filters.NewArgs(filters.Arg("label", "com.supabase.cli.project="+utils.Config.ProjectId)),
		})
		if err != nil {
			return err
		}

		fmt.Println("Project:", utils.Bold(utils.Config.ProjectId))

		fmt.Println("Containers: ")
		fmt.Println("---")
		for _, container := range containers {
			service := strings.Join(container.Names, " | ")

			if len(service) > 0 && service[0] == '/' {
				service = service[1:]
			}

			id := container.ID

			if useShortId {
				id = id[0:4]
			}

			fmt.Println("Name:", utils.Bold(service))
			fmt.Println("ID:", utils.Bold(id))
			fmt.Println("Image:", utils.Bold(container.Image))

			state := utils.Aqua(container.State)

			if container.State != "running" {
				state = utils.Red(container.State)
			}

			fmt.Println("State:", utils.Bold(state))
			fmt.Println("Status:", utils.Bold(container.Status))
			fmt.Println("---")
		}
	}

	return nil
}
