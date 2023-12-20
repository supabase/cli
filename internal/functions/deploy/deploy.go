package deploy

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"net/http"
	"os"
	"path"
	"path/filepath"

	"github.com/andybalholm/brotli"
	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/api/types/network"
	"github.com/docker/go-units"
	"github.com/go-errors/errors"
	"github.com/spf13/afero"
	"github.com/spf13/viper"
	"github.com/supabase/cli/internal/db/start"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/pkg/api"
)

const (
	eszipContentType       = "application/vnd.denoland.eszip"
	compressedEszipMagicId = "EZBR"

	// Import Map from CLI flag, i.e. --import-map, takes priority over config.toml & fallback.
	dockerImportMapPath = utils.DockerDenoDir + "/import_map.json"
	dockerOutputDir     = "/root/eszips"
)

func Run(ctx context.Context, slugs []string, projectRef string, noVerifyJWT *bool, importMapPath string, fsys afero.Fs) error {
	// Load function config and project id
	if err := utils.LoadConfigFS(fsys); err != nil {
		return err
	}
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
		return nil, errors.Errorf("failed to glob function slugs: %w", err)
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

func bundleFunction(ctx context.Context, slug, dockerEntrypointPath, importMapPath string, fsys afero.Fs) (*bytes.Buffer, error) {
	cwd, err := os.Getwd()
	if err != nil {
		return nil, errors.Errorf("failed to get working directory: %w", err)
	}

	// create temp directory to store generated eszip
	hostOutputDir := filepath.Join(utils.TempDir, fmt.Sprintf(".output_%s", slug))
	if err := fsys.MkdirAll(hostOutputDir, 0755); err != nil {
		return nil, errors.Errorf("failed to mkdir: %w", err)
	}
	defer func() {
		if err := fsys.RemoveAll(hostOutputDir); err != nil {
			fmt.Fprintln(os.Stderr, err)
		}
	}()

	outputPath := dockerOutputDir + "/output.eszip"
	binds := []string{
		// Reuse deno cache directory, ie. DENO_DIR, between container restarts
		// https://denolib.gitbook.io/guide/advanced/deno_dir-code-fetch-and-cache
		utils.EdgeRuntimeId + ":/root/.cache/deno:rw,z",
		filepath.Join(cwd, utils.FunctionsDir) + ":" + utils.DockerFuncDirPath + ":ro,z",
		filepath.Join(cwd, hostOutputDir) + ":" + dockerOutputDir + ":rw,z",
	}

	cmd := []string{"bundle", "--entrypoint", dockerEntrypointPath, "--output", outputPath}
	if viper.GetBool("DEBUG") {
		cmd = append(cmd, "--verbose")
	}

	if importMapPath != "" {
		modules, err := utils.BindImportMap(importMapPath, dockerImportMapPath, fsys)
		if err != nil {
			return nil, err
		}
		binds = append(binds, modules...)
		cmd = append(cmd, "--import-map", dockerImportMapPath)
	}

	err = utils.DockerRunOnceWithConfig(
		ctx,
		container.Config{
			Image: utils.EdgeRuntimeImage,
			Env:   []string{},
			Cmd:   cmd,
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
	if err != nil {
		return nil, err
	}

	eszipBytes, err := fsys.Open(filepath.Join(hostOutputDir, "output.eszip"))
	if err != nil {
		return nil, errors.Errorf("failed to open eszip: %w", err)
	}
	defer eszipBytes.Close()

	compressedBuf := bytes.NewBufferString(compressedEszipMagicId)
	brw := brotli.NewWriter(compressedBuf)
	defer brw.Close()

	_, err = io.Copy(brw, eszipBytes)
	if err != nil {
		return nil, errors.Errorf("failed to compress brotli: %w", err)
	}

	return compressedBuf, nil
}

func deployFunction(ctx context.Context, projectRef, slug, entrypointUrl, importMapUrl string, verifyJWT bool, functionBody io.Reader) error {
	resp, err := utils.GetSupabase().GetFunctionWithResponse(ctx, projectRef, slug)
	if err != nil {
		return errors.Errorf("failed to retrieve function: %w", err)
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
			return errors.Errorf("failed to create function: %w", err)
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
			return errors.Errorf("failed to update function: %w", err)
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

func deployOne(ctx context.Context, slug, projectRef, importMapPath string, noVerifyJWT *bool, fsys afero.Fs) error {
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
			return errors.Errorf("failed to resolve absolute path: %w", err)
		}
	}
	exists, _ := afero.Exists(fsys, resolved)
	if exists {
		importMapPath = resolved
	} else {
		importMapPath = ""
	}

	// 2. Bundle Function.
	fmt.Println("Bundling " + utils.Bold(slug))
	dockerEntrypointPath := path.Join(utils.DockerFuncDirPath, slug, "index.ts")
	functionBody, err := bundleFunction(ctx, slug, dockerEntrypointPath, importMapPath, fsys)
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
		"file://"+dockerEntrypointPath,
		"file://"+dockerImportMapPath,
		!*noVerifyJWT,
		functionBody,
	)
}

// TODO: api has a race condition that prevents deploying in parallel
const maxConcurrency = 1

func deployAll(ctx context.Context, slugs []string, projectRef, importMapPath string, noVerifyJWT *bool, fsys afero.Fs) error {
	errCh := make(chan error, maxConcurrency)
	errCh <- nil
	for _, slug := range slugs {
		// Log all errors and proceed
		if err := <-errCh; err != nil {
			return err
		}
		go func(slug string) {
			errCh <- deployOne(ctx, slug, projectRef, importMapPath, noVerifyJWT, fsys)
		}(slug)
	}
	return <-errCh
}
