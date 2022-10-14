package stop

import (
	"context"
	_ "embed"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/docker/docker/api/types"
	"github.com/docker/docker/api/types/filters"
	"github.com/spf13/afero"
	"github.com/supabase/cli/internal/utils"
)

var (
	//go:embed templates/dump.sh
	dumpScript string
)

func Run(ctx context.Context, backup bool, fsys afero.Fs) error {
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

	if backup {
		if err := backupDatabase(ctx, fsys); err != nil {
			return err
		}
	}

	// Stop all services
	if err := stop(ctx); err != nil {
		return err
	}
	fmt.Println("Stopped " + utils.Aqua("supabase") + " local development setup.")

	if !backup {
		// Remove other branches
		branchDir := filepath.Dir(utils.CurrBranchPath)
		if err := fsys.RemoveAll(branchDir); err != nil {
			fmt.Fprintln(os.Stderr, err)
		}
	}

	return nil
}

func backupDatabase(ctx context.Context, fsys afero.Fs) error {
	out, err := utils.DockerRunOnce(ctx, utils.Pg14Image, []string{
		"EXCLUDED_SCHEMAS=" + strings.Join(utils.InternalSchemas, "|"),
		"DB_URL=postgresql://postgres:postgres@" + utils.DbId + ":5432/postgres",
	}, []string{"bash", "-c", dumpScript})
	if err != nil {
		return errors.New("Error running pg_dump on local database: " + err.Error())
	}
	branch, err := utils.GetCurrentBranchFS(fsys)
	if err != nil {
		branch = "main"
	}
	branchDir := filepath.Join(filepath.Dir(utils.CurrBranchPath), branch)
	if err := utils.MkdirIfNotExistFS(fsys, branchDir); err != nil {
		return err
	}
	path := filepath.Join(branchDir, "dump.sql")
	return afero.WriteFile(fsys, path, []byte(out), 0644)
}

func stop(ctx context.Context) error {
	args := filters.NewArgs(
		filters.Arg("label", "com.supabase.cli.project="+utils.Config.ProjectId),
	)
	containers, err := utils.Docker.ContainerList(ctx, types.ContainerListOptions{
		All:     true,
		Filters: args,
	})
	if err != nil {
		return err
	}
	// Remove containers.
	ids := make([]string, len(containers))
	for i, c := range containers {
		ids[i] = c.ID
	}
	utils.DockerRemoveContainers(ctx, ids)
	// Remove networks.
	_, err = utils.Docker.NetworksPrune(ctx, args)
	return err
}
