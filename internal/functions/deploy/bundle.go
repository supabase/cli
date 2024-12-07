package deploy

import (
	"context"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"

	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/api/types/network"
	"github.com/go-errors/errors"
	"github.com/spf13/afero"
	"github.com/spf13/viper"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/pkg/function"
)

type dockerBundler struct {
	fsys afero.Fs
}

func NewDockerBundler(fsys afero.Fs) function.EszipBundler {
	return &dockerBundler{fsys: fsys}
}

func (b *dockerBundler) Bundle(ctx context.Context, entrypoint string, importMap string, output io.Writer) error {
	// Create temp directory to store generated eszip
	slug := filepath.Base(filepath.Dir(entrypoint))
	fmt.Fprintln(os.Stderr, "Bundling Function:", utils.Bold(slug))
	cwd, err := os.Getwd()
	if err != nil {
		return errors.Errorf("failed to get working directory: %w", err)
	}
	// BitBucket pipelines require docker bind mounts to be world writable
	hostOutputDir := filepath.Join(utils.TempDir, fmt.Sprintf(".output_%s", slug))
	if err := b.fsys.MkdirAll(hostOutputDir, 0777); err != nil {
		return errors.Errorf("failed to mkdir: %w", err)
	}
	defer func() {
		if err := b.fsys.RemoveAll(hostOutputDir); err != nil {
			fmt.Fprintln(os.Stderr, err)
		}
	}()
	// Create bind mounts
	binds, err := GetBindMounts(cwd, utils.FunctionsDir, hostOutputDir, entrypoint, importMap, b.fsys)
	if err != nil {
		return err
	}
	hostOutputPath := filepath.Join(hostOutputDir, "output.eszip")
	// Create exec command
	cmd := []string{"bundle", "--entrypoint", utils.ToDockerPath(entrypoint), "--output", utils.ToDockerPath(hostOutputPath)}
	if len(importMap) > 0 {
		cmd = append(cmd, "--import-map", utils.ToDockerPath(importMap))
	}
	if viper.GetBool("DEBUG") {
		cmd = append(cmd, "--verbose")
	}
	// Run bundle
	if err := utils.DockerRunOnceWithConfig(
		ctx,
		container.Config{
			Image:      utils.Config.EdgeRuntime.Image,
			Env:        []string{},
			Cmd:        cmd,
			WorkingDir: utils.ToDockerPath(cwd),
		},
		container.HostConfig{
			Binds: binds,
		},
		network.NetworkingConfig{},
		"",
		os.Stdout,
		os.Stderr,
	); err != nil {
		return err
	}
	// Read and compress
	eszipBytes, err := b.fsys.Open(hostOutputPath)
	if err != nil {
		return errors.Errorf("failed to open eszip: %w", err)
	}
	defer eszipBytes.Close()
	return function.Compress(eszipBytes, output)
}

func GetBindMounts(cwd, hostFuncDir, hostOutputDir, hostEntrypointPath, hostImportMapPath string, fsys afero.Fs) ([]string, error) {
	sep := string(filepath.Separator)
	// Docker requires all host paths to be absolute
	if !filepath.IsAbs(hostFuncDir) {
		hostFuncDir = filepath.Join(cwd, hostFuncDir)
	}
	if !strings.HasSuffix(hostFuncDir, sep) {
		hostFuncDir += sep
	}
	dockerFuncDir := utils.ToDockerPath(hostFuncDir)
	// TODO: bind ./supabase/functions:/home/deno/functions to hide PII?
	binds := []string{
		// Reuse deno cache directory, ie. DENO_DIR, between container restarts
		// https://denolib.gitbook.io/guide/advanced/deno_dir-code-fetch-and-cache
		utils.EdgeRuntimeId + ":/root/.cache/deno:rw",
		hostFuncDir + ":" + dockerFuncDir + ":ro",
	}
	if len(hostOutputDir) > 0 {
		if !filepath.IsAbs(hostOutputDir) {
			hostOutputDir = filepath.Join(cwd, hostOutputDir)
		}
		if !strings.HasSuffix(hostOutputDir, sep) {
			hostOutputDir += sep
		}
		if !strings.HasPrefix(hostOutputDir, hostFuncDir) {
			dockerOutputDir := utils.ToDockerPath(hostOutputDir)
			binds = append(binds, hostOutputDir+":"+dockerOutputDir+":rw")
		}
	}
	// Allow entrypoints outside the functions directory
	hostEntrypointDir := filepath.Dir(hostEntrypointPath)
	if len(hostEntrypointDir) > 0 {
		if !filepath.IsAbs(hostEntrypointDir) {
			hostEntrypointDir = filepath.Join(cwd, hostEntrypointDir)
		}
		if !strings.HasSuffix(hostEntrypointDir, sep) {
			hostEntrypointDir += sep
		}
		if !strings.HasPrefix(hostEntrypointDir, hostFuncDir) &&
			!strings.HasPrefix(hostEntrypointDir, hostOutputDir) {
			dockerEntrypointDir := utils.ToDockerPath(hostEntrypointDir)
			binds = append(binds, hostEntrypointDir+":"+dockerEntrypointDir+":ro")
		}
	}
	// Imports outside of ./supabase/functions will be bound by absolute path
	if len(hostImportMapPath) > 0 {
		if !filepath.IsAbs(hostImportMapPath) {
			hostImportMapPath = filepath.Join(cwd, hostImportMapPath)
		}
		importMap, err := utils.NewImportMap(hostImportMapPath, fsys)
		if err != nil {
			return nil, err
		}
		modules := importMap.BindHostModules()
		dockerImportMapPath := utils.ToDockerPath(hostImportMapPath)
		modules = append(modules, hostImportMapPath+":"+dockerImportMapPath+":ro")
		// Remove any duplicate mount points
		for _, mod := range modules {
			hostPath := strings.Split(mod, ":")[0]
			if !strings.HasPrefix(hostPath, hostFuncDir) &&
				(len(hostOutputDir) == 0 || !strings.HasPrefix(hostPath, hostOutputDir)) &&
				(len(hostEntrypointDir) == 0 || !strings.HasPrefix(hostPath, hostEntrypointDir)) {
				binds = append(binds, mod)
			}
		}
	}
	return binds, nil
}
