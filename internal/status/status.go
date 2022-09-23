package status

import (
	"context"
	"fmt"
	"io"
	"os"

	"github.com/spf13/afero"
	"github.com/supabase/cli/internal/utils"
)

func Run(ctx context.Context, fsys afero.Fs) error {
	// Sanity checks.
	{
		if err := utils.AssertSupabaseCliIsSetUpFS(fsys); err != nil {
			return err
		}
		if err := utils.LoadConfigFS(fsys); err != nil {
			return err
		}
		if err := utils.AssertDockerIsRunning(); err != nil {
			return err
		}
	}

	services := []string{
		utils.DbId,
		utils.KongId,
		utils.GotrueId,
		utils.InbucketId,
		utils.RealtimeId,
		utils.RestId,
		utils.StorageId,
		utils.PgmetaId,
		utils.StudioId,
	}
	return showServiceHealth(ctx, services, os.Stderr)
}

func showServiceHealth(ctx context.Context, services []string, stderr io.Writer) error {
	for _, name := range services {
		resp, err := utils.Docker.ContainerInspect(ctx, name)
		if err != nil {
			return fmt.Errorf("container %s not found. Have your run %s?", name, utils.Aqua("supabase start"))
		}
		if !resp.State.Running {
			fmt.Fprintln(stderr, name, "container is not running:", resp.State.Status)
		}
	}

	fmt.Fprintln(stderr, utils.Aqua("supabase"), "local development setup is running.")
	utils.ShowStatus()
	return nil
}
