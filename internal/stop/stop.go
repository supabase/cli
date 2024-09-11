package stop

import (
	"context"
	_ "embed"
	"fmt"
	"io"

	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/api/types/filters"
	"github.com/docker/docker/api/types/volume"
	"github.com/spf13/afero"
	"github.com/supabase/cli/internal/utils"
)

func Run(ctx context.Context, backup bool, projectId string, all bool, fsys afero.Fs) error {
	if all {
		return stopAllInstances(ctx, backup, fsys)
	}
	return stopOneProject(ctx, backup, projectId, fsys)
}

func stopOneProject(ctx context.Context, backup bool, projectId string, fsys afero.Fs) error {
	// Sanity checks.
	if len(projectId) > 0 {
		utils.Config.ProjectId = projectId
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
	if resp, err := utils.Docker.VolumeList(ctx, volume.ListOptions{
		Filters: utils.CliProjectFilter(),
	}); err == nil && len(resp.Volumes) > 0 {
		listVolume := fmt.Sprintf("docker volume ls --filter label=%s=%s", utils.CliProjectLabel, utils.Config.ProjectId)
		utils.CmdSuggestion = "Local data are backed up to docker volume. Use docker to show them: " + utils.Aqua(listVolume)
	}
	return nil
}

func stopAllInstances(ctx context.Context, backup bool, fsys afero.Fs) error {
	// Gather all containers and volumes matching the supabase project label
	containers, _ := utils.Docker.ContainerList(ctx, container.ListOptions{
		All:     true,
		Filters: filters.NewArgs(filters.Arg("label", utils.CliProjectLabel)),
	})
	volumes, _ := utils.Docker.VolumeList(ctx, volume.ListOptions{
		Filters: filters.NewArgs(filters.Arg("label", utils.CliProjectLabel)),
	})

	// Gather a unique list of project IDs from containers and volumes
	projectIds := make(map[string]struct{})
	for _, c := range containers {
		projectId := c.Labels[utils.CliProjectLabel]
		projectIds[projectId] = struct{}{}
	}
	for _, v := range volumes.Volumes {
		projectId := v.Labels[utils.CliProjectLabel]
		projectIds[projectId] = struct{}{}
	}

	// Stop each running Supabase project
	for projectId := range projectIds {
		fmt.Printf("Stopping project: %s\n", utils.Aqua(projectId))
		if err := stopOneProject(ctx, backup, projectId, fsys); err != nil {
			fmt.Printf("Error stopping project %s: %v\n", projectId, err)
		}
	}
	fmt.Println("Stopped all local Supabase project instances.")
	return nil
}

func stop(ctx context.Context, backup bool, w io.Writer) error {
	utils.NoBackupVolume = !backup
	return utils.DockerRemoveAll(ctx, w)
}
