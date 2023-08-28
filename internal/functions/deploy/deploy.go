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

	"github.com/docker/go-units"
	"github.com/spf13/afero"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/pkg/api"
)

const eszipContentType = "application/vnd.denoland.eszip"

func Run(ctx context.Context, slugs []string, projectRef string, noVerifyJWT *bool, importMapPath string, fsys afero.Fs) error {
	// Load function config if any for fallbacks for some flags, but continue on error.
	_ = utils.LoadConfigFS(fsys)
	if len(slugs) == 0 {
		allSlugs, err := getFunctionSlugs(fsys)
		if err != nil {
			return err
		}
		slugs = allSlugs
	} else {
		for _, slug := range slugs {
			if err := utils.ValidateFunctionSlug(slug); err != nil {
				return err
			}
		}
	}
	if len(slugs) == 0 {
		return errors.New("No Functions specified or found in " + utils.Bold(utils.FunctionsDir))
	}
	return deployAll(ctx, slugs, projectRef, importMapPath, noVerifyJWT, fsys)
}

func getFunctionSlugs(fsys afero.Fs) ([]string, error) {
	pattern := filepath.Join(utils.FunctionsDir, "*", "index.ts")
	paths, err := afero.Glob(fsys, pattern)
	if err != nil {
		return nil, err
	}
	var slugs []string
	for _, path := range paths {
		slug := filepath.Base(filepath.Dir(path))
		if utils.FuncSlugPattern.MatchString(slug) {
			slugs = append(slugs, slug)
		}
	}
	return slugs, nil
}

func bundleFunction(ctx context.Context, entrypointPath, importMapPath, buildScriptPath string) (*bytes.Buffer, error) {
	denoPath, err := utils.GetDenoPath()
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

func deployFunction(ctx context.Context, projectRef, slug, entrypointUrl, importMapUrl string, verifyJWT bool, functionBody io.Reader) error {
	resp, err := utils.GetSupabase().GetFunctionWithResponse(ctx, projectRef, slug)
	if err != nil {
		return err
	}

	switch resp.StatusCode() {
	case http.StatusNotFound: // Function doesn't exist yet, so do a POST
		resp, err := utils.GetSupabase().CreateFunctionWithBodyWithResponse(ctx, projectRef, &api.CreateFunctionParams{
			Slug:           &slug,
			Name:           &slug,
			VerifyJwt:      &verifyJWT,
			ImportMapPath:  &importMapUrl,
			EntrypointPath: &entrypointUrl,
		}, eszipContentType, functionBody)
		if err != nil {
			return err
		}
		if resp.JSON201 == nil {
			return errors.New("Failed to create a new Function on the Supabase project: " + string(resp.Body))
		}
	case http.StatusOK: // Function already exists, so do a PATCH
		resp, err := utils.GetSupabase().UpdateFunctionWithBodyWithResponse(ctx, projectRef, slug, &api.UpdateFunctionParams{
			VerifyJwt:      &verifyJWT,
			ImportMapPath:  &importMapUrl,
			EntrypointPath: &entrypointUrl,
		}, eszipContentType, functionBody)
		if err != nil {
			return err
		}
		if resp.JSON200 == nil {
			return errors.New("Failed to update an existing Function's body on the Supabase project: " + string(resp.Body))
		}
	default:
		return errors.New("Unexpected error deploying Function: " + string(resp.Body))
	}

	fmt.Println("Deployed Function " + utils.Aqua(slug) + " on project " + utils.Aqua(projectRef))
	url := fmt.Sprintf("%s/project/%v/functions/%v/details", utils.GetSupabaseDashboardURL(), projectRef, slug)
	fmt.Println("You can inspect your deployment in the Dashboard: " + url)
	return nil
}

func deployOne(ctx context.Context, slug, projectRef, importMapPath, buildScriptPath string, noVerifyJWT *bool, fsys afero.Fs) error {
	// 1. Ensure noVerifyJWT is not nil.
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
	// Upstream server expects import map to be always defined
	if importMapPath == "" {
		resolved, err = filepath.Abs(utils.FallbackImportMapPath)
		if err != nil {
			return err
		}
	}
	importMapPath = resolved
	// 2. Bundle Function.
	entrypointPath, err := filepath.Abs(filepath.Join(utils.FunctionsDir, slug, "index.ts"))
	if err != nil {
		return err
	}
	fmt.Println("Bundling " + utils.Bold(slug))
	functionBody, err := bundleFunction(ctx, entrypointPath, importMapPath, buildScriptPath)
	if err != nil {
		return err
	}
	// 3. Deploy new Function.
	functionSize := units.HumanSize(float64(functionBody.Len()))
	fmt.Println("Deploying " + utils.Bold(slug) + " (script size: " + utils.Bold(functionSize) + ")")
	return deployFunction(
		ctx,
		projectRef,
		slug,
		"file://"+entrypointPath,
		"file://"+importMapPath,
		!*noVerifyJWT,
		functionBody,
	)
}

// TODO: api has a race condition that prevents deploying in parallel
const maxConcurrency = 1

func deployAll(ctx context.Context, slugs []string, projectRef, importMapPath string, noVerifyJWT *bool, fsys afero.Fs) error {
	// Setup deno binaries
	if err := utils.InstallOrUpgradeDeno(ctx, fsys); err != nil {
		return err
	}
	scriptDir, err := utils.CopyDenoScripts(ctx, fsys)
	if err != nil {
		return err
	}
	errCh := make(chan error, maxConcurrency)
	errCh <- nil
	for _, slug := range slugs {
		// Log all errors and proceed
		if err := <-errCh; err != nil {
			return err
		}
		go func(slug string) {
			errCh <- deployOne(ctx, slug, projectRef, importMapPath, scriptDir.BuildPath, noVerifyJWT, fsys)
		}(slug)
	}
	return <-errCh
}
