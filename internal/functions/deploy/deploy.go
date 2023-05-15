package deploy

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os/exec"
	"path/filepath"
	"strings"

	"github.com/docker/go-units"
	"github.com/spf13/afero"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/pkg/api"
)

const eszipContentType = "application/vnd.denoland.eszip"

func Run(ctx context.Context, slug string, projectRef string, noVerifyJWT *bool, useLegacyBundle bool, importMapPath string, fsys afero.Fs) error {
	// 1. Sanity checks.
	{
		// Load function config if any for fallbacks for some flags, but continue on error.
		_ = utils.LoadConfigFS(fsys)
		// Ensure noVerifyJWT is not nil.
		if noVerifyJWT == nil {
			x := false
			if functionConfig, ok := utils.Config.Functions[slug]; ok && !*functionConfig.VerifyJWT {
				x = true
			}
			noVerifyJWT = &x
		}
		resolved, err := utils.AbsImportMapPath(importMapPath, slug, fsys)
		if err != nil {
			return err
		}
		importMapPath = resolved
		if err := utils.ValidateFunctionSlug(slug); err != nil {
			return err
		}
		if err := utils.InstallOrUpgradeDeno(ctx, fsys); err != nil {
			return err
		}
	}

	// 2. Bundle Function.
	scriptDir, err := utils.CopyDenoScripts(ctx, fsys)
	if err != nil {
		return err
	}
	functionBody, err := bundleFunction(ctx, slug, importMapPath, scriptDir.BuildPath, fsys)
	if err != nil {
		return err
	}
	functionSize := functionBody.Len()

	// 3. Deploy new Function.
	fmt.Println("Deploying " + utils.Bold(slug) + " (script size: " + utils.Bold(units.HumanSize(float64(functionSize))) + ")")
	return deployFunction(ctx, projectRef, slug, functionBody, !*noVerifyJWT, useLegacyBundle)
}

func bundleFunction(ctx context.Context, slug, importMapPath, buildScriptPath string, fsys afero.Fs) (*bytes.Buffer, error) {
	fmt.Println("Bundling " + utils.Bold(slug))
	denoPath, err := utils.GetDenoPath()
	if err != nil {
		return nil, err
	}
	entrypointPath, err := filepath.Abs(filepath.Join(utils.FunctionsDir, slug, "index.ts"))
	if err != nil {
		return nil, err
	}
	// Bundle function and import_map with deno
	args := []string{"run", "-A", buildScriptPath, entrypointPath, importMapPath}
	cmd := exec.CommandContext(ctx, denoPath, args...)
	var outBuf, errBuf bytes.Buffer
	cmd.Stdout = &outBuf
	cmd.Stderr = &errBuf
	if err := cmd.Run(); err != nil {
		return nil, fmt.Errorf("Error bundling function: %w\n%v", err, errBuf.String())
	}
	return &outBuf, nil
}

func makeLegacyFunctionBody(functionBody io.Reader) (string, error) {
	buf := new(strings.Builder)
	_, err := io.Copy(buf, functionBody)
	if err != nil {
		return "", err
	}

	return buf.String(), nil
}

// TODO: Remove `useLegacyBundle` after 2023-06-01
func deployFunction(ctx context.Context, projectRef, slug string, functionBody io.Reader, verifyJWT, useLegacyBundle bool) error {
	{
		resp, err := utils.GetSupabase().GetFunctionWithResponse(ctx, projectRef, slug)
		if err != nil {
			return err
		}

		var functionBodyStr string
		if useLegacyBundle {
			functionBodyStr, err = makeLegacyFunctionBody(functionBody)
			if err != nil {
				return err
			}
		}

		// Note: imageMap is always set to true, since eszip created will always contain a `import_map.json`.
		importMap := true

		switch resp.StatusCode() {
		case http.StatusNotFound: // Function doesn't exist yet, so do a POST
			var resp *api.CreateFunctionResponse
			var err error
			if useLegacyBundle {
				resp, err = utils.GetSupabase().CreateFunctionWithResponse(ctx, projectRef, &api.CreateFunctionParams{}, api.CreateFunctionJSONRequestBody{
					Body:      functionBodyStr,
					Name:      slug,
					Slug:      slug,
					VerifyJwt: &verifyJWT,
				})
			} else {
				resp, err = utils.GetSupabase().CreateFunctionWithBodyWithResponse(ctx, projectRef, &api.CreateFunctionParams{
					Slug:      &slug,
					Name:      &slug,
					VerifyJwt: &verifyJWT,
					ImportMap: &importMap,
				}, eszipContentType, functionBody)
			}
			if err != nil {
				return err
			}
			if resp.JSON201 == nil {
				return errors.New("Failed to create a new Function on the Supabase project: " + string(resp.Body))
			}
		case http.StatusOK: // Function already exists, so do a PATCH
			var resp *api.UpdateFunctionResponse
			var err error
			if useLegacyBundle {
				resp, err = utils.GetSupabase().UpdateFunctionWithResponse(ctx, projectRef, slug, &api.UpdateFunctionParams{}, api.UpdateFunctionJSONRequestBody{
					Body:      &functionBodyStr,
					VerifyJwt: &verifyJWT,
				})
			} else {
				resp, err = utils.GetSupabase().UpdateFunctionWithBodyWithResponse(ctx, projectRef, slug, &api.UpdateFunctionParams{
					VerifyJwt: &verifyJWT,
					ImportMap: &importMap,
				}, eszipContentType, functionBody)
			}
			if err != nil {
				return err
			}
			if resp.JSON200 == nil {
				return errors.New("Failed to update an existing Function's body on the Supabase project: " + string(resp.Body))
			}
		default:
			return errors.New("Unexpected error deploying Function: " + string(resp.Body))
		}
	}

	fmt.Println("Deployed Function " + utils.Aqua(slug) + " on project " + utils.Aqua(projectRef))

	url := fmt.Sprintf("%s/project/%v/functions/%v/details", utils.GetSupabaseDashboardURL(), projectRef, slug)
	fmt.Println("You can inspect your deployment in the Dashboard: " + url)

	return nil
}
