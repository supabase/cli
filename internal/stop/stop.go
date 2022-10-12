package stop

import (
	"context"
	"fmt"
	"path/filepath"

	"github.com/docker/docker/api/types"
	"github.com/docker/docker/api/types/filters"
	"github.com/spf13/afero"
	"github.com/supabase/cli/internal/utils"
)

func Run(ctx context.Context, fsys afero.Fs) error {
	// Sanity checks.
	{
		if err := utils.LoadConfigFS(fsys); err != nil {
			return err
		}
		if err := utils.AssertSupabaseDbIsRunning(); err != nil {
			fmt.Println(utils.Aqua("supabase") + " local development setup is already stopped.")
			return nil
		}
	}

	// Stop all services
	if err := stop(ctx); err != nil {
		return err
	}

	// Remove other branches
	branchDir := filepath.Dir(utils.CurrBranchPath)
	if err := fsys.RemoveAll(branchDir); err != nil {
		return err
	}
	fmt.Println("Stopped " + utils.Aqua("supabase") + " local development setup.")

	return nil
}

func stop(ctx context.Context) error {
	args := filters.NewArgs(
		filters.Arg("label", "com.supabase.cli.project="+utils.Config.ProjectId),
	)
	// Remove containers.
	containers, err := utils.Docker.ContainerList(ctx, types.ContainerListOptions{
		All:     true,
		Filters: args,
	})
	if err != nil {
		return err
	}

	ids := make([]string, len(containers))
	for i, c := range containers {
		ids[i] = c.ID
	}
	utils.DockerRemoveContainers(ctx, ids)

	// Remove networks.
	_, err = utils.Docker.NetworksPrune(ctx, args)
	return err
}
