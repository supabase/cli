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
	"github.com/supabase/cli/pkg/config"
	"github.com/supabase/cli/pkg/function"
)

func Run(ctx context.Context, slugs []string, useDocker bool, noVerifyJWT *bool, importMapPath string, fsys afero.Fs) error {
	// Load function config and project id
	if err := flags.LoadConfig(fsys); err != nil {
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
	if useDocker {
		api := function.NewEdgeRuntimeAPI(flags.ProjectRef, *utils.GetSupabase(), NewDockerBundler(fsys))
		if err := api.UpsertFunctions(ctx, functionConfig); err != nil {
			return err
		}
	} else if err := deploy(ctx, functionConfig, fsys); err != nil {
		return err
	}
	fmt.Printf("Deployed Functions on project %s: %s\n", utils.Aqua(flags.ProjectRef), strings.Join(slugs, ", "))
	url := fmt.Sprintf("%s/project/%v/functions", utils.GetSupabaseDashboardURL(), flags.ProjectRef)
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
	for slug := range utils.Config.Functions {
		slugs = append(slugs, slug)
	}
	return slugs, nil
}

func GetFunctionConfig(slugs []string, importMapPath string, noVerifyJWT *bool, fsys afero.Fs) (config.FunctionConfig, error) {
	// Although some functions do not require import map, it's more convenient to setup
	// vscode deno extension with a single import map for all functions.
	fallbackExists := true
	functionsUsingDeprecatedGlobalFallback := []string{}
	functionsUsingDeprecatedImportMap := []string{}
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
		function, ok := utils.Config.Functions[name]
		if !ok {
			function.Enabled = true
			function.VerifyJWT = true
		}
		// Precedence order: flag > config > fallback
		functionDir := filepath.Join(utils.FunctionsDir, name)
		if len(function.Entrypoint) == 0 {
			function.Entrypoint = filepath.Join(functionDir, "index.ts")
		}
		if len(importMapPath) > 0 {
			function.ImportMap = importMapPath
		} else if len(function.ImportMap) == 0 {
			denoJsonPath := filepath.Join(functionDir, "deno.json")
			denoJsoncPath := filepath.Join(functionDir, "deno.jsonc")
			importMapPath := filepath.Join(functionDir, "import_map.json")
			if _, err := fsys.Stat(denoJsonPath); err == nil {
				function.ImportMap = denoJsonPath
			} else if _, err := fsys.Stat(denoJsoncPath); err == nil {
				function.ImportMap = denoJsoncPath
			} else if _, err := fsys.Stat(importMapPath); err == nil {
				function.ImportMap = importMapPath
				functionsUsingDeprecatedImportMap = append(functionsUsingDeprecatedImportMap, name)
			} else if fallbackExists {
				function.ImportMap = utils.FallbackImportMapPath
				functionsUsingDeprecatedGlobalFallback = append(functionsUsingDeprecatedGlobalFallback, name)
			}
		}
		if noVerifyJWT != nil {
			function.VerifyJWT = !*noVerifyJWT
		}
		functionConfig[name] = function
	}
	if len(functionsUsingDeprecatedImportMap) > 0 {
		fmt.Fprintln(os.Stderr,
			utils.Yellow("WARNING:"),
			"Functions using deprecated import_map.json (please migrate to deno.json):",
			utils.Aqua(strings.Join(functionsUsingDeprecatedImportMap, ", ")),
		)
	}
	if len(functionsUsingDeprecatedGlobalFallback) > 0 {
		fmt.Fprintln(os.Stderr,
			utils.Yellow("WARNING:"),
			"Functions using fallback import map:",
			utils.Aqua(strings.Join(functionsUsingDeprecatedGlobalFallback, ", ")),
		)
		fmt.Fprintln(os.Stderr,
			"Please use recommended per function dependency declaration ",
			utils.Aqua("https://supabase.com/docs/guides/functions/import-maps"),
		)
	}
	return functionConfig, nil
}
