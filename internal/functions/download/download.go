package download

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path"
	"path/filepath"
	"strings"

	"github.com/andybalholm/brotli"
	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/api/types/network"
	"github.com/go-errors/errors"
	"github.com/spf13/afero"
	"github.com/spf13/viper"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/internal/utils/flags"
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
	resp, err := utils.GetSupabase().V1GetAFunctionWithResponse(ctx, projectRef, slug)
	if err != nil {
		return nil, errors.Errorf("failed to get function metadata: %w", err)
	}

	switch resp.StatusCode() {
	case http.StatusNotFound:
		return nil, errors.Errorf("Function %s does not exist on the Supabase project.", utils.Aqua(slug))
	case http.StatusOK:
		break
	default:
		return nil, errors.Errorf("Failed to download Function %s on the Supabase project: %s", utils.Aqua(slug), string(resp.Body))
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

	resp, err := utils.GetSupabase().V1GetAFunctionBodyWithResponse(ctx, projectRef, slug)
	if err != nil {
		return errors.Errorf("failed to get function body: %w", err)
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
		return errors.Errorf("Error downloading function: %w\n%v", err, errBuf.String())
	}
	return nil
}

func Run(ctx context.Context, slug string, projectRef string, useLegacyBundle bool, fsys afero.Fs) error {
	if useLegacyBundle {
		return RunLegacy(ctx, slug, projectRef, fsys)
	}
	// 1. Sanity check
	if err := flags.LoadConfig(fsys); err != nil {
		return err
	}
	// 2. Download eszip to temp file
	eszipPath, err := downloadOne(ctx, slug, projectRef, fsys)
	if err != nil {
		return err
	}
	if !viper.GetBool("DEBUG") {
		defer func() {
			if err := fsys.Remove(eszipPath); err != nil {
				fmt.Fprintln(os.Stderr, err)
			}
		}()
	}
	// Extract eszip to functions directory
	err = extractOne(ctx, slug, eszipPath)
	if err != nil {
		utils.CmdSuggestion += suggestLegacyBundle(slug)
	}
	return err
}

func downloadOne(ctx context.Context, slug, projectRef string, fsys afero.Fs) (string, error) {
	fmt.Println("Downloading " + utils.Bold(slug))
	resp, err := utils.GetSupabase().V1GetAFunctionBody(ctx, projectRef, slug)
	if err != nil {
		return "", errors.Errorf("failed to get function body: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		body, err := io.ReadAll(resp.Body)
		if err != nil {
			return "", errors.Errorf("Error status %d: unexpected error downloading Function", resp.StatusCode)
		}
		return "", errors.Errorf("Error status %d: %s", resp.StatusCode, string(body))
	}
	r := io.Reader(resp.Body)
	if strings.EqualFold(resp.Header.Get("Content-Encoding"), "br") {
		r = brotli.NewReader(resp.Body)
	}
	// Create temp file to store downloaded eszip
	eszipPath := filepath.Join(utils.TempDir, fmt.Sprintf("output_%s.eszip", slug))
	if err := utils.MkdirIfNotExistFS(fsys, utils.TempDir); err != nil {
		return "", err
	}
	if err := afero.WriteReader(fsys, eszipPath, r); err != nil {
		return "", errors.Errorf("failed to download file: %w", err)
	}
	return eszipPath, nil
}

func extractOne(ctx context.Context, slug, eszipPath string) error {
	hostFuncDirPath, err := filepath.Abs(filepath.Join(utils.FunctionsDir, slug))
	if err != nil {
		return errors.Errorf("failed to resolve absolute path: %w", err)
	}

	hostEszipPath, err := filepath.Abs(eszipPath)
	if err != nil {
		return errors.Errorf("failed to resolve eszip path: %w", err)
	}
	dockerEszipPath := path.Join(utils.DockerEszipDir, filepath.Base(hostEszipPath))

	binds := []string{
		// Reuse deno cache directory, ie. DENO_DIR, between container restarts
		// https://denolib.gitbook.io/guide/advanced/deno_dir-code-fetch-and-cache
		utils.EdgeRuntimeId + ":/root/.cache/deno:rw",
		hostEszipPath + ":" + dockerEszipPath + ":ro",
		hostFuncDirPath + ":" + utils.DockerDenoDir + ":rw",
	}

	return utils.DockerRunOnceWithConfig(
		ctx,
		container.Config{
			Image: utils.Config.EdgeRuntime.Image,
			Cmd:   []string{"unbundle", "--eszip", dockerEszipPath, "--output", utils.DockerDenoDir},
		},
		container.HostConfig{
			Binds: binds,
		},
		network.NetworkingConfig{},
		"",
		os.Stdout,
		os.Stderr,
	)
}

func suggestLegacyBundle(slug string) string {
	return fmt.Sprintf("\nIf your function is deployed using CLI < 1.120.0, trying running %s instead.", utils.Aqua("supabase functions download --legacy-bundle "+slug))
}
