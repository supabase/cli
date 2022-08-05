package delete

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"path/filepath"

	"github.com/docker/docker/api/types"
	"github.com/docker/docker/pkg/stdcopy"
	"github.com/spf13/afero"
	"github.com/supabase/cli/internal/utils"
)

func Run(branch string, fsys afero.Fs) error {
	if err := utils.LoadConfigFS(fsys); err != nil {
		return err
	}
	if err := utils.AssertSupabaseDbIsRunning(); err != nil {
		return err
	}

	// TODO: update branch history atomically with database
	if err := deleteBranchDir(branch, fsys); err != nil {
		return err
	}

	ctx := context.Background()
	if err := deleteBranchPG(ctx, branch); err != nil {
		return err
	}

	fmt.Println("Deleted branch " + utils.Aqua(branch) + ".")
	return nil
}

func deleteBranchDir(branch string, fsys afero.Fs) error {
	if currBranch, _ := utils.GetCurrentBranchFS(fsys); branch == currBranch {
		return errors.New("Cannot delete current branch.")
	}

	if utils.IsBranchNameReserved(branch) {
		return errors.New("Cannot delete branch " + utils.Aqua(branch) + ": branch name is reserved.")
	}

	branchPath := filepath.Join(filepath.Dir(utils.CurrBranchPath), branch)
	if _, err := afero.ReadDir(fsys, branchPath); err != nil {
		return errors.New("Branch " + utils.Aqua(branch) + " does not exist.")
	}

	if err := fsys.RemoveAll(branchPath); err != nil {
		return fmt.Errorf("Failed deleting branch %s: %w", utils.Aqua(branch), err)
	}

	return nil
}

func deleteBranchPG(ctx context.Context, branch string) error {
	exec, err := utils.Docker.ContainerExecCreate(ctx, utils.DbId, types.ExecConfig{
		Cmd:          []string{"dropdb", "--username", "postgres", "--host", "127.0.0.1", branch},
		AttachStderr: true,
		AttachStdout: true,
	})
	if err != nil {
		return err
	}
	// Read exec output
	resp, err := utils.Docker.ContainerExecAttach(ctx, exec.ID, types.ExecStartCheck{})
	if err != nil {
		return err
	}
	defer resp.Close()
	// Capture error details
	var errBuf bytes.Buffer
	if _, err := stdcopy.StdCopy(io.Discard, &errBuf, resp.Reader); err != nil {
		return err
	}
	// Get the exit code
	iresp, err := utils.Docker.ContainerExecInspect(ctx, exec.ID)
	if err != nil {
		return err
	}
	if iresp.ExitCode > 0 {
		return errors.New("Error deleting branch: " + errBuf.String())
	}
	return nil
}
