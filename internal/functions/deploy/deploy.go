package deploy

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"

	"github.com/andybalholm/brotli"
	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/api/types/network"
	"github.com/docker/go-units"
	"github.com/spf13/afero"
	"github.com/spf13/viper"
	"github.com/supabase/cli/internal/db/start"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/pkg/api"
)

const (
	eszipContentType = "application/vnd.denoland.eszip"

	dockerFuncDirPath = utils.DockerDenoDir + "/functions"
	// Import Map from CLI flag, i.e. --import-map, takes priority over config.toml & fallback.
	dockerImportMapPath = utils.DockerDenoDir + "/import_map.json"
)

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

func bundleFunction(ctx context.Context, dockerEntrypointPath, importMapPath string, fsys afero.Fs) (*bytes.Buffer, error) {
	cwd, err := os.Getwd()
	if err != nil {
		return nil, err
	}

	// create temp directory to store generated eszip
	tmpDir, err := os.MkdirTemp("", "eszip")
	if err != nil {
		return nil, err
	}
	defer os.RemoveAll(tmpDir)
	outputPath := "/root/eszips/output.eszip"

	binds := []string{
		// Reuse deno cache directory, ie. DENO_DIR, between container restarts
		// https://denolib.gitbook.io/guide/advanced/deno_dir-code-fetch-and-cache
		utils.EdgeRuntimeId + ":/root/.cache/deno:rw,z",
		filepath.Join(cwd, utils.FunctionsDir) + ":" + dockerFuncDirPath + ":ro,z",
		tmpDir + ":/root/eszips:rw,z",
	}

	if importMapPath != "" {
		modules, err := utils.BindImportMap(importMapPath, dockerImportMapPath, fsys)
		if err != nil {
			return nil, err
		}
		binds = append(binds, modules...)
	}

	cmd := []string{"bundle", "--entrypoint", dockerEntrypointPath, "--output", outputPath, "--import-map", dockerImportMapPath}
	if viper.GetBool("DEBUG") {
		cmd = append(cmd, "--verbose")
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
		network.NetworkingConfig{
			EndpointsConfig: map[string]*network.EndpointSettings{
				utils.NetId: {
					Aliases: utils.EdgeRuntimeAliases,
				},
			},
		},
		"edge-runtime-bundle",
		os.Stdout,
		os.Stderr,
	)
	if err != nil {
		return nil, err
	}

	eszipBytes, err := os.ReadFile(filepath.Join(tmpDir, "output.eszip"))
	eszipBuf := bytes.NewBuffer(eszipBytes)

	compressedBuf := &bytes.Buffer{}
	_, err = compressedBuf.WriteString("EZBR")
	if err != nil {
		return nil, err
	}

	brw := brotli.NewWriter(compressedBuf)
	_, err = eszipBuf.WriteTo(brw)
	if err != nil {
		return nil, err
	}
	brw.Close()

	return compressedBuf, nil
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
			return err
		}
	}
	importMapPath = resolved
	// 2. Bundle Function.
	dockerEntrypointPath, err := filepath.Abs(filepath.Join(dockerFuncDirPath, slug, "index.ts"))
	if err != nil {
		return err
	}
	fmt.Println("Bundling " + utils.Bold(slug))
	functionBody, err := bundleFunction(ctx, dockerEntrypointPath, importMapPath, fsys)
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
