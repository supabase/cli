package stop

import (
	"context"
	_ "embed"
	"fmt"
	"io"

	"github.com/spf13/afero"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/internal/utils/flags"
)

func Run(ctx context.Context, backup bool, projectId string, all bool, fsys afero.Fs) error {
	var searchProjectIdFilter string
	if !all {
		// Sanity checks.
		if len(projectId) > 0 {
			utils.Config.ProjectId = projectId
		} else if err := flags.LoadConfig(fsys); err != nil {
			return err
		}
		searchProjectIdFilter = utils.Config.ProjectId
	}
	if utils.UsesAppleContainerRuntime() {
		if err := utils.StopAppleAnalyticsForwarders(fsys); err != nil {
			return err
		}
	}

	// Stop all services
	if err := utils.RunProgram(ctx, func(p utils.Program, ctx context.Context) error {
		w := utils.StatusWriter{Program: p}
		return stop(ctx, backup, w, searchProjectIdFilter)
	}); err != nil {
		return err
	}

	fmt.Println("Stopped " + utils.Aqua("supabase") + " local development setup.")
	if volumes, err := utils.ListProjectVolumes(ctx, searchProjectIdFilter); err == nil && len(volumes) > 0 {
		if len(searchProjectIdFilter) > 0 {
			if utils.UsesAppleContainerRuntime() {
				listVolume := fmt.Sprintf("container volume list --format json | jq '.[] | select(.labels.\"%s\" == \"%s\")'", utils.CliProjectLabel, searchProjectIdFilter)
				utils.CmdSuggestion = "Local data are backed up to apple container volumes. Use the container CLI to show them: " + utils.Aqua(listVolume)
			} else {
				listVolume := fmt.Sprintf("docker volume ls --filter label=%s=%s", utils.CliProjectLabel, searchProjectIdFilter)
				utils.CmdSuggestion = "Local data are backed up to docker volume. Use docker to show them: " + utils.Aqua(listVolume)
			}
		} else {
			if utils.UsesAppleContainerRuntime() {
				listVolume := fmt.Sprintf("container volume list --format json | jq '.[] | select(.labels.\"%s\")'", utils.CliProjectLabel)
				utils.CmdSuggestion = "Local data are backed up to apple container volumes. Use the container CLI to show them: " + utils.Aqua(listVolume)
			} else {
				listVolume := fmt.Sprintf("docker volume ls --filter label=%s", utils.CliProjectLabel)
				utils.CmdSuggestion = "Local data are backed up to docker volume. Use docker to show them: " + utils.Aqua(listVolume)
			}
		}
	}
	return nil
}

func stop(ctx context.Context, backup bool, w io.Writer, projectId string) error {
	utils.NoBackupVolume = !backup
	return utils.DockerRemoveAll(ctx, w, projectId)
}
