package stop

import (
	"context"
	_ "embed"
	"fmt"
	"io"
	"os"
	"strconv"
	"syscall"

	"github.com/docker/docker/api/types/volume"
	"github.com/spf13/afero"
	"github.com/supabase/cli/internal/start"
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

	// Stop embedded mail server if running
	stopEmbeddedMailServer()

	// Stop all services
	if err := utils.RunProgram(ctx, func(p utils.Program, ctx context.Context) error {
		w := utils.StatusWriter{Program: p}
		return stop(ctx, backup, w, searchProjectIdFilter)
	}); err != nil {
		return err
	}

	fmt.Println("Stopped " + utils.Aqua("supabase") + " local development setup.")
	if resp, err := utils.Docker.VolumeList(ctx, volume.ListOptions{
		Filters: utils.CliProjectFilter(searchProjectIdFilter),
	}); err == nil && len(resp.Volumes) > 0 {
		if len(searchProjectIdFilter) > 0 {
			listVolume := fmt.Sprintf("docker volume ls --filter label=%s=%s", utils.CliProjectLabel, searchProjectIdFilter)
			utils.CmdSuggestion = "Local data are backed up to docker volume. Use docker to show them: " + utils.Aqua(listVolume)
		} else {
			listVolume := fmt.Sprintf("docker volume ls --filter label=%s", utils.CliProjectLabel)
			utils.CmdSuggestion = "Local data are backed up to docker volume. Use docker to show them: " + utils.Aqua(listVolume)
		}
	}
	return nil
}

func stop(ctx context.Context, backup bool, w io.Writer, projectId string) error {
	utils.NoBackupVolume = !backup
	return utils.DockerRemoveAll(ctx, w, projectId)
}

// stopEmbeddedMailServer reads the PID file and sends SIGTERM to stop the embedded mail server
func stopEmbeddedMailServer() {
	pidPath, err := start.GetEmbeddedMailPidPath()
	if err != nil {
		return
	}

	// Read PID file
	pidBytes, err := os.ReadFile(pidPath)
	if err != nil {
		// PID file doesn't exist, embedded server not running
		return
	}

	pid, err := strconv.Atoi(string(pidBytes))
	if err != nil {
		// Invalid PID, remove the stale file
		os.Remove(pidPath)
		return
	}

	// Find the process
	process, err := os.FindProcess(pid)
	if err != nil {
		// Process not found, remove stale PID file
		os.Remove(pidPath)
		return
	}

	// Send SIGTERM to gracefully stop the process
	fmt.Println("Stopping embedded mail server...")
	if err := process.Signal(syscall.SIGTERM); err != nil {
		// Process might already be dead, remove PID file
		os.Remove(pidPath)
		return
	}

	// Note: The supabase start process will clean up its own PID file when it exits
}
