package deploy

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/go-errors/errors"
	"github.com/spf13/afero"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/pkg/config"
	"github.com/supabase/cli/pkg/function"
)

func Run(ctx context.Context, slugs []string, projectRef string, noVerifyJWT *bool, importMapPath string, fsys afero.Fs) error {
	// Load function config and project id
	var skippedFunctions []string
	if err := utils.LoadConfigFS(fsys); err != nil {
		return err
	} else if len(slugs) > 0 {
		for _, s := range slugs {
			if err := utils.ValidateFunctionSlug(s); err != nil {
				return err
			}
		}
	} else if slugs, skippedFunctions, err = GetFunctionSlugs(fsys); err != nil {
		return err
	}
	if len(skippedFunctions) > 0 {
		fmt.Fprintf(utils.GetDebugLogger(), "Skipped deploying the following functions: %s\n", strings.Join(skippedFunctions, ", "))
	}
	// TODO: require all functions to be deployed from config for v2
	if len(slugs) == 0 {
		return errors.Errorf("No Functions specified or found in %s", utils.Bold(utils.FunctionsDir))
	}
	functionConfig, err := GetFunctionConfig(slugs, importMapPath, noVerifyJWT, fsys)
	if err != nil {
		return err
	}
	api := function.NewEdgeRuntimeAPI(projectRef, *utils.GetSupabase(), NewDockerBundler(fsys))
	if err := api.UpsertFunctions(ctx, functionConfig); err != nil {
		return err
	}
	fmt.Printf("Deployed Functions on project %s: %s\n", utils.Aqua(projectRef), strings.Join(slugs, ", "))
	url := fmt.Sprintf("%s/project/%v/functions", utils.GetSupabaseDashboardURL(), projectRef)
	fmt.Println("You can inspect your deployment in the Dashboard: " + url)
	return nil
}

func GetFunctionSlugs(fsys afero.Fs) (slugs []string, disabledSlugs []string, err error) {
	pattern := filepath.Join(utils.FunctionsDir, "*", "index.ts")
	paths, err := afero.Glob(fsys, pattern)
	if err != nil {
		return nil, nil, errors.Errorf("failed to glob function slugs: %w", err)
	}
	for _, path := range paths {
		slug := filepath.Base(filepath.Dir(path))
		if utils.FuncSlugPattern.MatchString(slug) {
			if utils.Config.Functions[slug].IsEnabled() {
				slugs = append(slugs, slug)
			} else {
				disabledSlugs = append(disabledSlugs, slug)
			}
		}
	}
	return slugs, disabledSlugs, nil
}

func GetFunctionConfig(slugs []string, importMapPath string, noVerifyJWT *bool, fsys afero.Fs) (config.FunctionConfig, error) {
	// Although some functions do not require import map, it's more convenient to setup
	// vscode deno extension with a single import map for all functions.
	fallbackExists := true
	if _, err := fsys.Stat(utils.FallbackImportMapPath); errors.Is(err, os.ErrNotExist) {
		fallbackExists = false
	} else if err != nil {
		return nil, errors.Errorf("failed to fallback import map: %w", err)
	}
	// Flag import map is specified relative to current directory instead of workdir
	if len(importMapPath) > 0 && !filepath.IsAbs(importMapPath) {
		importMapPath = filepath.Join(utils.CurrentDirAbs, importMapPath)
	}
	functionConfig := make(config.FunctionConfig, len(slugs))
	for _, name := range slugs {
		function := utils.Config.Functions[name]
		// Precedence order: flag > config > fallback
		if len(function.Entrypoint) == 0 {
			function.Entrypoint = filepath.Join(utils.FunctionsDir, name, "index.ts")
		}
		if len(importMapPath) > 0 {
			function.ImportMap = importMapPath
		} else if len(function.ImportMap) == 0 && fallbackExists {
			function.ImportMap = utils.FallbackImportMapPath
		}
		if noVerifyJWT != nil {
			function.VerifyJWT = utils.Ptr(!*noVerifyJWT)
		}
		functionConfig[name] = function
	}
	return functionConfig, nil
}
