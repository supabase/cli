package list

import (
	"context"
	"fmt"
	"os"
	"text/tabwriter"

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

	containers, err := utils.GetProjectContainers(ctx)
	if err != nil {
		return err
	}

	if len(containers) == 0 {
		fmt.Println(fmt.Sprintf("There aren't any containers for %s project", utils.Bold(utils.Config.ProjectId)))
	} else {
		w := tabwriter.NewWriter(os.Stdout, 0, 0, 2, ' ', tabwriter.TabIndent)

		fmt.Fprintf(w, "%s\t%s\t%s\t", utils.Bold("ID"), utils.Bold("SERVICE"), utils.Bold("STATE"))
		fmt.Fprintln(w)
		for _, container := range containers {
			state := utils.Aqua(container.State)

			if container.State != "running" {
				state = utils.Red(container.State)
			}

			fmt.Fprintf(w, "%s\t%s\t%s\t%s", utils.Bold(container.ID[:6]), utils.Bold(utils.ContainerName(container.Names)), utils.Bold(state), utils.Bold(container.Image))
			fmt.Fprintln(w)
		}

		w.Flush()
	}

	return nil
}
