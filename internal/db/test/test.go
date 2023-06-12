package test

import (
	"archive/tar"
	"bytes"
	"context"
	_ "embed"
	"io"
	"os"
	"path"
	"path/filepath"

	"github.com/docker/docker/api/types"
	"github.com/spf13/afero"
	"github.com/supabase/cli/internal/utils"
)

var (
	//go:embed templates/test.sh
	testScript string
)

func Run(ctx context.Context, fsys afero.Fs) error {
	// Sanity checks.
	{
		if err := utils.LoadConfigFS(fsys); err != nil {
			return err
		}

		if err := utils.AssertSupabaseDbIsRunning(); err != nil {
			return err
		}
	}

	return pgProve(ctx, "/tmp", fsys)
}

func pgProve(ctx context.Context, dstPath string, fsys afero.Fs) error {
	// Copy tests into database container
	var buf bytes.Buffer
	if err := compress(utils.DbTestsDir, &buf, fsys); err != nil {
		return err
	}
	if err := utils.Docker.CopyToContainer(ctx, utils.DbId, dstPath, &buf, types.CopyToContainerOptions{}); err != nil {
		return err
	}

	// Passing in script string means command line args must be set manually, ie. "$@"
	testsPath := path.Join(filepath.Dir(utils.DbTestsDir), filepath.Base(utils.DbTestsDir))
	args := "cd " + dstPath + ";set -- " + testsPath + ";"
	// Requires unix path inside container
	cmd := []string{"/bin/bash", "-c", args + testScript}
	return utils.DockerExecOnceWithStream(ctx, utils.DbId, nil, cmd, os.Stdout, os.Stderr)
}

// Ref 1: https://medium.com/@skdomino/taring-untaring-files-in-go-6b07cf56bc07
// Ref 2: https://gist.github.com/mimoo/25fc9716e0f1353791f5908f94d6e726
func compress(src string, buf io.Writer, fsys afero.Fs) error {
	tw := tar.NewWriter(buf)

	// walk through every file in the folder
	if err := afero.Walk(fsys, src, func(file string, fi os.FileInfo, err error) error {
		// return on any error
		if err != nil {
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
	}); err != nil {
		return err
	}

	// produce tar
	if err := tw.Close(); err != nil {
		return err
	}
	return nil
}
