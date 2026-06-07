package deploy

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/go-errors/errors"
	"github.com/spf13/afero"
	"github.com/supabase/cli/internal/functions/delete"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/internal/utils/flags"
	"github.com/supabase/cli/pkg/api"
	"github.com/supabase/cli/pkg/config"
	"github.com/supabase/cli/pkg/function"
)

func Run(ctx context.Context, slugs []string, useDocker bool, noVerifyJWT *bool, importMapPath string, maxJobs uint, prune bool, fsys afero.Fs) error {
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
	// Flag import map is specified relative to current directory instead of workdir
	cwd, err := os.Getwd()
	if err != nil {
		return errors.Errorf("failed to get working directory: %w", err)
	}
	if len(importMapPath) > 0 {
		if !filepath.IsAbs(importMapPath) {
			importMapPath = filepath.Join(utils.CurrentDirAbs, importMapPath)
		}
		if importMapPath, err = filepath.Rel(cwd, importMapPath); err != nil {
			return errors.Errorf("failed to resolve relative path: %w", err)
		}
	}
	functionConfig, err := GetFunctionConfig(slugs, importMapPath, noVerifyJWT, fsys)
	if err != nil {
		return err
	}
	// Deploy new and updated functions
	opt := function.WithMaxJobs(maxJobs)
	if useDocker {
		if utils.IsDockerRunning(ctx) {
			opt = function.WithBundler(NewDockerBundler(fsys))
		} else {
			fmt.Fprintln(os.Stderr, utils.Yellow("WARNING:"), "Docker is not running")
		}
	}
	api := function.NewEdgeRuntimeAPI(flags.ProjectRef, *utils.GetSupabase(), opt)
	if err := api.Deploy(ctx, functionConfig, afero.NewIOFS(fsys)); errors.Is(err, function.ErrNoDeploy) {
		fmt.Fprintln(os.Stderr, err)
		return nil
	} else if err != nil {
		return err
	}
	fmt.Printf("Deployed Functions on project %s: %s\n", utils.Aqua(flags.ProjectRef), strings.Join(slugs, ", "))
	url := fmt.Sprintf("%s/project/%v/functions", utils.GetSupabaseDashboardURL(), flags.ProjectRef)
	fmt.Println("You can inspect your deployment in the Dashboard: " + url)
	if !prune {
		return nil
	}
	return pruneFunctions(ctx, functionConfig)
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

// pruneFunctions deletes functions that exist remotely but not locally
func pruneFunctions(ctx context.Context, functionConfig config.FunctionConfig) error {
	resp, err := utils.GetSupabase().V1ListAllFunctionsWithResponse(ctx, flags.ProjectRef)
	if err != nil {
		return errors.Errorf("failed to list functions: %w", err)
	} else if resp.JSON200 == nil {
		return errors.Errorf("unexpected list functions status %d: %s", resp.StatusCode(), string(resp.Body))
	}
	// No need to delete disabled functions
	var toDelete []string
	for _, deployed := range *resp.JSON200 {
		if deployed.Status == api.FunctionResponseStatusREMOVED {
			continue
		} else if _, exists := functionConfig[deployed.Slug]; exists {
			continue
		}
		toDelete = append(toDelete, deployed.Slug)
	}
	if len(toDelete) == 0 {
		fmt.Fprintln(os.Stderr, "No Functions to prune.")
		return nil
	}
	// Confirm before pruning functions
	msg := fmt.Sprintln(confirmPruneAll(toDelete))
	if shouldDelete, err := utils.NewConsole().PromptYesNo(ctx, msg, false); err != nil {
		return err
	} else if !shouldDelete {
		return errors.New(context.Canceled)
	}
	for _, slug := range toDelete {
		fmt.Fprintln(os.Stderr, "Deleting Function:", slug)
		if err := delete.Undeploy(ctx, flags.ProjectRef, slug); errors.Is(err, delete.ErrNoDelete) {
			fmt.Fprintln(utils.GetDebugLogger(), err)
		} else if err != nil {
			return err
		}
	}
	return nil
}

func confirmPruneAll(pending []string) string {
	msg := fmt.Sprintln("Do you want to delete the following Functions from your project?")
	for _, slug := range pending {
		msg += fmt.Sprintf(" • %s\n", utils.Bold(slug))
	}
	return msg
}
