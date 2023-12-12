package stop

import (
	"context"
	_ "embed"
	"fmt"
	"io"
	"os"

	"github.com/docker/docker/api/types"
	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/errdefs"
	"github.com/go-errors/errors"
	"github.com/spf13/afero"
	"github.com/supabase/cli/internal/utils"
)

func Run(ctx context.Context, backup bool, projectId string, fsys afero.Fs) error {
	// Sanity checks.
	if len(projectId) > 0 {
		utils.Config.ProjectId = projectId
		utils.UpdateDockerIds()
	} else if err := utils.LoadConfigFS(fsys); err != nil {
		return err
	}

	// Stop all services
	if err := utils.RunProgram(ctx, func(p utils.Program, ctx context.Context) error {
		w := utils.StatusWriter{Program: p}
		return stop(ctx, backup, w)
	}); err != nil {
		return err
	}

	fmt.Println("Stopped " + utils.Aqua("supabase") + " local development setup.")
	return nil
}

func stop(ctx context.Context, backup bool, w io.Writer) error {
	args := utils.CliProjectFilter()
	containers, err := utils.Docker.ContainerList(ctx, types.ContainerListOptions{
		All:     true,
		Filters: args,
	})
	if err != nil {
		return err
	}
	// Gracefully shutdown containers
	var ids []string
	for _, c := range containers {
		if c.State == "running" {
			ids = append(ids, c.ID)
		}
	}
	fmt.Fprintln(w, "Stopping containers...")
	result := utils.WaitAll(ids, func(id string) error {
		return utils.Docker.ContainerStop(ctx, id, container.StopOptions{})
	})
	if err := errors.Join(result...); err != nil {
		return err
	}
	if _, err := utils.Docker.ContainersPrune(ctx, args); err != nil {
		return err
	}
	// Remove named volumes
	if backup {
		fmt.Fprintln(os.Stderr, "Postgres database saved to volume:", utils.DbId)
		fmt.Fprintln(os.Stderr, "Postgres config saved to volume:", utils.ConfigId)
		fmt.Fprintln(os.Stderr, "Storage directory saved to volume:", utils.StorageId)
		fmt.Fprintln(os.Stderr, "Functions cache saved to volume:", utils.EdgeRuntimeId)
		fmt.Fprintln(os.Stderr, "Inbucket emails saved to volume:", utils.InbucketId)
	} else {
		// TODO: label named volumes to use VolumesPrune for branch support
		volumes := []string{
			utils.ConfigId,
			utils.DbId,
			utils.StorageId,
			utils.EdgeRuntimeId,
			utils.InbucketId,
		}
		result = utils.WaitAll(volumes, func(name string) error {
			if err := utils.Docker.VolumeRemove(ctx, name, true); err != nil && !errdefs.IsNotFound(err) {
				return errors.Errorf("Failed to remove volume %s: %w", name, err)
			}
			return nil
		})
		if err := errors.Join(result...); err != nil {
			return err
		}
	}
	// Remove networks.
	_, err = utils.Docker.NetworksPrune(ctx, args)
	return err
}
