package test

import (
	"archive/tar"
	"bytes"
	"context"
	_ "embed"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"

	"github.com/docker/docker/api/types"
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

	var buf bytes.Buffer
	if err := compress(testDir, &buf, fsys); err != nil {
		return err
	}
	dstPath := "/tmp"
	if err := utils.Docker.CopyToContainer(ctx, utils.DbId, dstPath, &buf, types.CopyToContainerOptions{}); err != nil {
		return err
	}

	subdirs := []string{dstPath + "/" + testDir}
	if err := afero.Walk(fsys, testDir, func(path string, info fs.FileInfo, err error) error {
		if info.IsDir() {
			subdirs = append(subdirs, dstPath+"/"+path)
		}
		return err
	}); err != nil {
		return err
	}

	cmd := append([]string{"/bin/sh", "-c", testScript}, subdirs...)
	out, err := utils.DockerExecOnce(ctx, utils.DbId, nil, cmd)
	if err != nil {
		return err
	}

	fmt.Println(out)
	return nil
}

// Ref 1: https://medium.com/@skdomino/taring-untaring-files-in-go-6b07cf56bc07
// Ref 2: https://gist.github.com/mimoo/25fc9716e0f1353791f5908f94d6e726
func compress(src string, buf io.Writer, fsys afero.Fs) error {
	tw := tar.NewWriter(buf)

	// walk through every file in the folder
	if err := afero.Walk(fsys, src, func(file string, fi os.FileInfo, err error) error {
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
	}); err != nil {
		return err
	}

	// produce tar
	if err := tw.Close(); err != nil {
		return err
	}
	return nil
}
