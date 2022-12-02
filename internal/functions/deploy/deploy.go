package deploy

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	"github.com/spf13/afero"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/pkg/api"
)

const EszipContentType = "application/vnd.denoland.eszip"

func Run(ctx context.Context, slug string, projectRefArg string, verifyJWT bool, useLegacyBundle bool, fsys afero.Fs) error {
	// 1. Sanity checks.
	projectRef := projectRefArg
	var buildScriptPath string
	{
		if len(projectRefArg) == 0 {
			ref, err := utils.LoadProjectRef(fsys)
			if err != nil {
				return err
			}
			projectRef = ref
		} else if !utils.ProjectRefPattern.MatchString(projectRef) {
			return errors.New("Invalid project ref format. Must be like `abcdefghijklmnopqrst`.")
		}
		if err := utils.ValidateFunctionSlug(slug); err != nil {
			return err
		}
		if err := utils.InstallOrUpgradeDeno(ctx, fsys); err != nil {
			return err
		}

		var err error
		buildScriptPath, err = utils.CopyEszipScripts(ctx, fsys)
		if err != nil {
			return err
		}
	}

	// 2. Bundle Function.
	var functionBody io.Reader
	{
		fmt.Println("Bundling " + utils.Bold(slug))
		denoPath, err := utils.GetDenoPath()
		if err != nil {
			return err
		}

		functionPath := filepath.Join(utils.FunctionsDir, slug)
		if _, err := fsys.Stat(functionPath); errors.Is(err, os.ErrNotExist) {
			// allow deploy from within supabase/
			functionPath = filepath.Join("functions", slug)
			if _, err := fsys.Stat(functionPath); errors.Is(err, os.ErrNotExist) {
				// allow deploy from current directory
				functionPath = slug
			}
		}

		args := []string{"run", "-A", buildScriptPath, filepath.Join(functionPath, "index.ts")}
		if useLegacyBundle {
			args = []string{"bundle", "--no-check=remote", "--quiet", filepath.Join(functionPath, "index.ts")}
		}
		cmd := exec.CommandContext(ctx, denoPath, args...)
		var outBuf, errBuf bytes.Buffer
		cmd.Stdout = &outBuf
		cmd.Stderr = &errBuf
		if err := cmd.Run(); err != nil {
			return fmt.Errorf("Error bundling function: %w\n%v", err, errBuf.String())
		}

		functionBody = &outBuf
	}

	// 3. Deploy new Function.
	return deployFunction(ctx, projectRef, slug, functionBody, verifyJWT, useLegacyBundle)
}

func makeLegacyFunctionBody(functionBody io.Reader) (string, error) {
	buf := new(strings.Builder)
	_, err := io.Copy(buf, functionBody)
	if err != nil {
		return "", err
	}

	return buf.String(), nil
}

func deployFunction(ctx context.Context, projectRef, slug string, functionBody io.Reader, verifyJWT, useLegacyBundle bool) error {
	var deployedFuncId string
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
				}, EszipContentType, functionBody)
			}
			if err != nil {
				return err
			}
			if resp.JSON201 == nil {
				return errors.New("Failed to create a new Function on the Supabase project: " + string(resp.Body))
			}
			deployedFuncId = resp.JSON201.Id
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
				}, EszipContentType, functionBody)
			}
			if err != nil {
				return err
			}
			if resp.JSON200 == nil {
				return errors.New("Failed to update an existing Function's body on the Supabase project: " + string(resp.Body))
			}
			deployedFuncId = resp.JSON200.Id
		default:
			return errors.New("Unexpected error deploying Function: " + string(resp.Body))
		}
	}

	fmt.Println("Deployed Function " + utils.Aqua(slug) + " on project " + utils.Aqua(projectRef))

	url := fmt.Sprintf("%s/project/%v/functions/%v/details", utils.GetSupabaseDashboardURL(), projectRef, deployedFuncId)
	fmt.Println("You can inspect your deployment in the Dashboard: " + url)

	return nil
}
