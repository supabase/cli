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
	"github.com/supabase/cli/internal/utils/flags"
	"github.com/supabase/cli/pkg/cast"
	"github.com/supabase/cli/pkg/config"
	"github.com/supabase/cli/pkg/function"
)

func Run(ctx context.Context, slugs []string, projectRef string, noVerifyJWT *bool, importMapPath string, fsys afero.Fs) error {
	// Load function config and project id
	if err := utils.LoadConfigFS(fsys); err != nil {
		return err
	} else if len(slugs) > 0 {
		for _, s := range slugs {
			if err := utils.ValidateFunctionSlug(s); err != nil {
				return err
			}
		}
	} else if slugs, err = GetFunctionSlugs(fsys); err != nil {
		return err
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

func GetFunctionSlugs(fsys afero.Fs) (slugs []string, err error) {
	pattern := filepath.Join(utils.FunctionsDir, "*", "index.ts")
	paths, err := afero.Glob(fsys, pattern)
	if err != nil {
		return nil, errors.Errorf("failed to glob function slugs: %w", err)
	}
	for _, path := range paths {
		slug := filepath.Base(filepath.Dir(path))
		if utils.FuncSlugPattern.MatchString(slug) {
			slugs = append(slugs, slug)
		}
	}
	// Add all function slugs declared in config file
	remote, _ := utils.Config.GetRemoteByProjectRef(flags.ProjectRef)
	for slug := range remote.Functions {
		slugs = append(slugs, slug)
	}
	return slugs, nil
}

func GetFunctionConfig(slugs []string, importMapPath string, noVerifyJWT *bool, fsys afero.Fs) (config.FunctionConfig, error) {
	// Flag import map is specified relative to current directory instead of workdir
	if len(importMapPath) > 0 && !filepath.IsAbs(importMapPath) {
		importMapPath = filepath.Join(utils.CurrentDirAbs, importMapPath)
	}
	remote, _ := utils.Config.GetRemoteByProjectRef(flags.ProjectRef)
	functionConfig := make(config.FunctionConfig, len(slugs))
	for _, name := range slugs {
		function := remote.Functions[name]
		// Precedence order: flag > config > fallback
		functionDir := filepath.Join(utils.FunctionsDir, name)
		if len(function.Entrypoint) == 0 {
			function.Entrypoint = filepath.Join(functionDir, "index.ts")
		}
		if len(importMapPath) > 0 {
			function.ImportMap = importMapPath
		} else if len(function.ImportMap) == 0 {
			if dedicatedFunctionPath, err := utils.GetImportsFilePath(functionDir, fsys); err == nil {
				function.ImportMap = dedicatedFunctionPath
			} else if fallbackFunctionPath, err := utils.GetImportsFilePath(utils.FunctionsDir, fsys); err == nil {
				function.ImportMap = fallbackFunctionPath
			}
		}
		if noVerifyJWT != nil {
			function.VerifyJWT = cast.Ptr(!*noVerifyJWT)
		}
		functionConfig[name] = function
	}
	// Check validity of ImportMap paths
	functionsWithFallback := []string{}
	if fallbacksPath, err := utils.GetImportsFilePath(utils.FunctionsDir, fsys); err == nil {
		for name, function := range functionConfig {
			if function.ImportMap == fallbacksPath {
				functionsWithFallback = append(functionsWithFallback, name)
			}
		}
		if len(functionsWithFallback) > 0 {
			fmt.Fprintf(os.Stderr, "Warning: The following functions are using the fallback import map at %s: %s\n",
				fallbacksPath,
				strings.Join(functionsWithFallback, ", "))
			fmt.Fprintln(os.Stderr, "This is not recommended and will be deprecated. Please move import maps into each function folder.")
		}
	}

	return functionConfig, nil
}
