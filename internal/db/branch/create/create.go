package create

import (
	"bytes"
	"context"
	_ "embed"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"

	"github.com/docker/docker/api/types"
	"github.com/docker/docker/pkg/stdcopy"
	"github.com/spf13/afero"
	"github.com/supabase/cli/internal/utils"
)

var (
	//go:embed templates/clone.sh
	cloneScript string
)

func Run(branch string, fsys afero.Fs) error {
	if err := utils.LoadConfigFS(fsys); err != nil {
		return err
	}
	if err := utils.AssertSupabaseDbIsRunning(); err != nil {
		return err
	}

	branchPath := filepath.Join(filepath.Dir(utils.CurrBranchPath), branch)
	if err := assertNewBranchIsValid(branchPath, fsys); err != nil {
		return nil
	}

	var ctx = context.Background()
	if err := createBranch(ctx, branch); err != nil {
		return err
	}

	if err := fsys.MkdirAll(branchPath, 0755); err != nil {
		return err
	}

	fmt.Println("Created branch " + utils.Aqua(branch) + ".")
	return nil
}

func assertNewBranchIsValid(branchPath string, fsys afero.Fs) error {
	branch := filepath.Base(branchPath)

	if utils.IsBranchNameReserved(branch) {
		return errors.New("Cannot create branch " + utils.Aqua(branch) + ": branch name is reserved.")
	}

	if !utils.BranchNamePattern.MatchString(branch) {
		return errors.New("Branch name " + utils.Aqua(branch) + " is invalid. Must match [0-9A-Za-z_-]+.")
	}

	if _, err := afero.ReadDir(fsys, branchPath); errors.Is(err, os.ErrNotExist) {
		// skip
	} else if err != nil {
		return err
	} else {
		return errors.New("Branch " + utils.Aqua(branch) + " already exists.")
	}

	return nil
}

func createBranch(ctx context.Context, branch string) error {
	exec, err := utils.Docker.ContainerExecCreate(ctx, utils.DbId, types.ExecConfig{
		Cmd:          []string{"/bin/bash", "-c", cloneScript},
		Env:          []string{"DB_NAME=" + branch},
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
		return errors.New("Error creating branch: " + errBuf.String())
	}
	return nil
}
