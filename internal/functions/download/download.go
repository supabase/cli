package download

import (
	"bytes"
	"context"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"

	"github.com/spf13/afero"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/pkg/api"
)

var (
	legacyEntrypointPath = "file:///src/index.ts"
	legacyImportMapPath  = "file:///src/import_map.json"
)

func Run(ctx context.Context, slug string, projectRef string, fsys afero.Fs) error {
	// 1. Sanity checks.
	{
		if err := utils.ValidateFunctionSlug(slug); err != nil {
			return utils.Red(err.Error())
		}
	}
	if err := utils.InstallOrUpgradeDeno(ctx, fsys); err != nil {
		return utils.Red(err.Error())
	}

	scriptDir, err := utils.CopyDenoScripts(ctx, fsys)
	if err != nil {
		return utils.Red(err.Error())
	}

	// 2. Download Function.
	if err := downloadFunction(ctx, projectRef, slug, scriptDir.ExtractPath); err != nil {
		return utils.Red(err.Error())
	}

	fmt.Println("Downloaded Function " + utils.Aqua(slug) + " from project " + utils.Aqua(projectRef) + ".")
	return nil
}

func getFunctionMetadata(ctx context.Context, projectRef, slug string) (*api.FunctionSlugResponse, error) {
	resp, err := utils.GetSupabase().GetFunctionWithResponse(ctx, projectRef, slug)
	if err != nil {
		return nil, utils.Red(err.Error())
	}

	switch resp.StatusCode() {
	case http.StatusNotFound:
		return nil, utils.Red("Function " + utils.Aqua(slug) + " does not exist on the Supabase project.")
	case http.StatusOK:
		break
	default:
		return nil, utils.Red("Failed to download Function " + utils.Aqua(slug) + " on the Supabase project: " + string(resp.Body))
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
		return utils.Red(err.Error())
	}

	meta, err := getFunctionMetadata(ctx, projectRef, slug)
	if err != nil {
		return utils.Red(err.Error())
	}

	resp, err := utils.GetSupabase().GetFunctionBodyWithResponse(ctx, projectRef, slug)
	if err != nil {
		return utils.Red(err.Error())
	}
	if resp.StatusCode() != http.StatusOK {
		return utils.Red("Unexpected error downloading Function: " + string(resp.Body))
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
		return utils.Red(fmt.Errorf("Error downloading function: %w\n%v", err, errBuf.String()).Error())
	}
	return nil
}
