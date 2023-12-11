package download

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path"
	"path/filepath"

	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/api/types/network"
	"github.com/spf13/afero"
	"github.com/supabase/cli/internal/db/start"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/pkg/api"
)

var (
	legacyEntrypointPath = "file:///src/index.ts"
	legacyImportMapPath  = "file:///src/import_map.json"
)

func RunLegacy(ctx context.Context, slug string, projectRef string, fsys afero.Fs) error {
	// 1. Sanity checks.
	{
		if err := utils.ValidateFunctionSlug(slug); err != nil {
			return err
		}
	}
	if err := utils.InstallOrUpgradeDeno(ctx, fsys); err != nil {
		return err
	}

	scriptDir, err := utils.CopyDenoScripts(ctx, fsys)
	if err != nil {
		return err
	}

	// 2. Download Function.
	if err := downloadFunction(ctx, projectRef, slug, scriptDir.ExtractPath); err != nil {
		return err
	}

	fmt.Println("Downloaded Function " + utils.Aqua(slug) + " from project " + utils.Aqua(projectRef) + ".")
	return nil
}

func getFunctionMetadata(ctx context.Context, projectRef, slug string) (*api.FunctionSlugResponse, error) {
	resp, err := utils.GetSupabase().GetFunctionWithResponse(ctx, projectRef, slug)
	if err != nil {
		return nil, err
	}

	switch resp.StatusCode() {
	case http.StatusNotFound:
		return nil, errors.New("Function " + utils.Aqua(slug) + " does not exist on the Supabase project.")
	case http.StatusOK:
		break
	default:
		return nil, errors.New("Failed to download Function " + utils.Aqua(slug) + " on the Supabase project: " + string(resp.Body))
	}

	if resp.JSON200.EntrypointPath == nil {
		resp.JSON200.EntrypointPath = &legacyEntrypointPath
	}
	if resp.JSON200.ImportMapPath == nil {
		resp.JSON200.ImportMapPath = &legacyImportMapPath
	}
	return resp.JSON200, nil
}

func downloadFunction(ctx context.Context, projectRef, slug, extractScriptPath string) error {
	fmt.Println("Downloading " + utils.Bold(slug))
	denoPath, err := utils.GetDenoPath()
	if err != nil {
		return err
	}

	meta, err := getFunctionMetadata(ctx, projectRef, slug)
	if err != nil {
		return err
	}

	resp, err := utils.GetSupabase().GetFunctionBodyWithResponse(ctx, projectRef, slug)
	if err != nil {
		return err
	}
	if resp.StatusCode() != http.StatusOK {
		return errors.New("Unexpected error downloading Function: " + string(resp.Body))
	}

	resBuf := bytes.NewReader(resp.Body)
	funcDir := filepath.Join(utils.FunctionsDir, slug)
	args := []string{"run", "-A", extractScriptPath, funcDir, *meta.EntrypointPath}
	cmd := exec.CommandContext(ctx, denoPath, args...)
	var errBuf bytes.Buffer
	cmd.Stdin = resBuf
	cmd.Stdout = os.Stdout
	cmd.Stderr = &errBuf
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("Error downloading function: %w\n%v", err, errBuf.String())
	}
	return nil
}

const dockerEszipDir = "/root/eszips"

func Run(ctx context.Context, slug string, projectRef string, useLegacyBundle bool, fsys afero.Fs) error {
	if useLegacyBundle {
		return RunLegacy(ctx, slug, projectRef, fsys)
	}
	// 1. Sanity check
	if err := utils.LoadConfigFS(fsys); err != nil {
		return err
	}
	// 2. Download eszip to temp file
	eszipPath, err := downloadOne(ctx, slug, projectRef, fsys)
	if err != nil {
		return err
	}
	defer func() {
		if err := fsys.Remove(eszipPath); err != nil {
			fmt.Fprintln(os.Stderr, err)
		}
	}()
	// Extract eszip to functions directory
	return extractOne(ctx, eszipPath, slug, fsys)
}

func downloadOne(ctx context.Context, slug string, projectRef string, fsys afero.Fs) (string, error) {
	fmt.Println("Downloading " + utils.Bold(slug))
	resp, err := utils.GetSupabase().GetFunctionBodyWithResponse(ctx, projectRef, slug)
	if err != nil {
		return "", err
	}
	if resp.StatusCode() != http.StatusOK {
		return "", errors.New("Unexpected error downloading Function: " + string(resp.Body))
	}

	// Create temp file to store downloaded eszip
	eszipFile, err := afero.TempFile(fsys, "", slug)
	if err != nil {
		return "", err
	}
	defer eszipFile.Close()

	body := bytes.NewReader(resp.Body)
	_, err = io.Copy(eszipFile, body)
	return eszipFile.Name(), err
}

func extractOne(ctx context.Context, hostEszipPath, slug string, fsys afero.Fs) error {
	hostFuncDirPath, err := filepath.Abs(utils.FunctionsDir)
	if err != nil {
		return err
	}

	dockerEszipPath := path.Join(dockerEszipDir, filepath.Base(hostEszipPath))
	binds := []string{
		// Reuse deno cache directory, ie. DENO_DIR, between container restarts
		// https://denolib.gitbook.io/guide/advanced/deno_dir-code-fetch-and-cache
		utils.EdgeRuntimeId + ":/root/.cache/deno:rw,z",
		hostEszipPath + ":" + dockerEszipPath + ":ro,z",
		hostFuncDirPath + ":" + utils.DockerFuncDirPath + ":rw,z",
	}

	return utils.DockerRunOnceWithConfig(
		ctx,
		container.Config{
			Image: utils.EdgeRuntimeImage,
			Cmd:   []string{"unbundle", "--eszip", dockerEszipPath, "--output", utils.DockerDenoDir},
		},
		start.WithSyslogConfig(container.HostConfig{
			Binds:      binds,
			ExtraHosts: []string{"host.docker.internal:host-gateway"},
		}),
		network.NetworkingConfig{},
		"",
		os.Stdout,
		os.Stderr,
	)
}
