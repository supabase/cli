package stop

import (
	"context"
	_ "embed"
	"fmt"
	"io"

	"github.com/docker/docker/api/types/volume"
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
	if resp, err := utils.Docker.VolumeList(ctx, volume.ListOptions{
		Filters: utils.CliProjectFilter(),
	}); err == nil && len(resp.Volumes) > 0 {
		listVolume := fmt.Sprintf("docker volume ls --filter label=%s=%s", utils.CliProjectLabel, utils.Config.ProjectId)
		utils.CmdSuggestion = "Local data are backed up to docker volume. Use docker to show them: " + utils.Aqua(listVolume)
	}
	return nil
}

func stop(ctx context.Context, backup bool, w io.Writer) error {
	utils.NoBackupVolume = !backup
	return utils.DockerRemoveAll(ctx, w)
}
