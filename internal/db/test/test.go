package test

import (
	"archive/tar"
	"bytes"
	"context"
	_ "embed"
	"errors"
	"fmt"
	"io"
	"os"
	"os/signal"
	"path/filepath"

	"github.com/docker/docker/api/types"
	"github.com/docker/docker/pkg/stdcopy"
	"github.com/spf13/afero"
	"github.com/supabase/cli/internal/utils"
)

const (
	testDir = "supabase/tests"
)

var (
	//go:embed templates/test.sh
	testScript string
)

func Run(fsys afero.Fs) error {
	// Sanity checks.
	{
		if err := utils.AssertSupabaseStartIsRunning(); err != nil {
			return err
		}
	}

	ctx := context.Background()
	// Trap Ctrl+C and call cancel on the context:
	// https://medium.com/@matryer/make-ctrl-c-cancel-the-context-context-bd006a8ad6ff
	ctx, cancel := context.WithCancel(ctx)
	c := make(chan os.Signal, 1)
	signal.Notify(c, os.Interrupt)
	defer func() {
		signal.Stop(c)
		cancel()
	}()
	go func() {
		select {
		case <-c:
			cancel()
		case <-ctx.Done():
		}
	}()

	var buf bytes.Buffer
	if err := compress(testDir, &buf, fsys); err != nil {
		return err
	}
	dstPath := "/tmp"
	if err := utils.Docker.CopyToContainer(ctx, utils.DbId, dstPath, &buf, types.CopyToContainerOptions{}); err != nil {
		return err
	}

	exec, err := utils.Docker.ContainerExecCreate(ctx, utils.DbId, types.ExecConfig{
		Cmd:          []string{"/bin/sh", "-c", testScript},
		Env:          []string{"TEST_DIR=" + testDir},
		WorkingDir:   dstPath,
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
	// Capture error details
	var errBuf bytes.Buffer
	var outBuf bytes.Buffer
	if _, err := stdcopy.StdCopy(&outBuf, &errBuf, resp.Reader); err != nil {
		return err
	}
	fmt.Println(outBuf.String())
	// Get the exit code
	iresp, err := utils.Docker.ContainerExecInspect(ctx, exec.ID)
	if err != nil {
		return err
	}
	if iresp.ExitCode > 0 {
		return errors.New("unit tests failed " + errBuf.String())
	}
	return nil
}

// Ref 1: https://medium.com/@skdomino/taring-untaring-files-in-go-6b07cf56bc07
// Ref 2: https://gist.github.com/mimoo/25fc9716e0f1353791f5908f94d6e726
func compress(src string, buf io.Writer, fsys afero.Fs) error {
	tw := tar.NewWriter(buf)

	// walk through every file in the folder
	afero.Walk(fsys, src, func(file string, fi os.FileInfo, err error) error {
		// return on any error
		if err != nil {
			fmt.Println(err)
			return err
		}

		// return on non-regular files
		if !fi.Mode().IsRegular() {
			return nil
		}

		// create a new dir/file header
		header, err := tar.FileInfoHeader(fi, fi.Name())
		if err != nil {
			return err
		}

		// must provide real name
		header.Name = filepath.ToSlash(file)

		// write the header
		if err := tw.WriteHeader(header); err != nil {
			return err
		}

		// open files for taring
		f, err := fsys.Open(file)
		if err != nil {
			return err
		}

		// copy file data into tar writer
		if _, err := io.Copy(tw, f); err != nil {
			return err
		}

		// manually close here after each file operation; defering would cause each file close
		// to wait until all operations have completed.
		if err := f.Close(); err != nil {
			return err
		}

		return nil
	})

	// produce tar
	if err := tw.Close(); err != nil {
		return err
	}
	return nil
}
