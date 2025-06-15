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

func Run(ctx context.Context, slugs []string, useDocker bool, noVerifyJWT *bool, importMapPath string, maxJobs uint, prune bool, force bool, fsys afero.Fs) error {
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

	// Handle pruning if requested
	if prune {
		if err := pruneFunctions(ctx, slugs, flags.ProjectRef, force); err != nil {
			return err
		}
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

// getRemoteFunctions gets the list of functions from the Supabase project
func getRemoteFunctions(ctx context.Context, projectRef string) ([]string, error) {
	resp, err := utils.GetSupabase().V1ListAllFunctionsWithResponse(ctx, projectRef)
	if err != nil {
		return nil, errors.Errorf("failed to list remote functions: %w", err)
	}

	if resp.JSON200 == nil {
		return nil, errors.New("Unexpected error retrieving functions: " + string(resp.Body))
	}

	var remoteSlugs []string
	for _, function := range *resp.JSON200 {
		remoteSlugs = append(remoteSlugs, function.Slug)
	}

	return remoteSlugs, nil
}

// pruneFunctions deletes functions that exist remotely but not locally
func pruneFunctions(ctx context.Context, localSlugs []string, projectRef string, force bool) error {
	// Get remote functions
	remoteSlugs, err := getRemoteFunctions(ctx, projectRef)
	if err != nil {
		return err
	}

	// Create a set of local function slugs for fast lookup
	localSet := make(map[string]bool)
	for _, slug := range localSlugs {
		localSet[slug] = true
	}

	// Find functions to prune (exist remotely but not locally)
	var functionsToDelete []string
	for _, remoteSlug := range remoteSlugs {
		if !localSet[remoteSlug] {
			functionsToDelete = append(functionsToDelete, remoteSlug)
		}
	}

	// If no functions to prune, return early
	if len(functionsToDelete) == 0 {
		fmt.Fprintln(os.Stderr, "No functions to prune.")
		return nil
	}

	// In interactive mode, prompt for confirmation (unless force is used)
	if !force && utils.NewConsole().IsTTY {
		message := fmt.Sprintf("The following functions will be DELETED from your project: %s", strings.Join(functionsToDelete, ", "))
		fmt.Fprintln(os.Stderr, utils.Yellow("WARNING:"), message)

		if confirmed, err := utils.NewConsole().PromptYesNo(ctx, "Are you sure?", false); err != nil {
			return err
		} else if !confirmed {
			fmt.Fprintln(os.Stderr, "Aborted.")
			return nil
		}
	}

	// Delete functions
	for _, slug := range functionsToDelete {
		fmt.Fprintf(os.Stderr, "Deleting function: %s\n", utils.Aqua(slug))
		resp, err := utils.GetSupabase().V1DeleteAFunctionWithResponse(ctx, projectRef, slug)
		if err != nil {
			return errors.Errorf("failed to delete function %s: %w", slug, err)
		}
		switch resp.StatusCode() {
		case 404:
			fmt.Fprintf(os.Stderr, "Function %s was already deleted.\n", utils.Aqua(slug))
		case 200:
			fmt.Fprintf(os.Stderr, "Successfully deleted function: %s\n", utils.Aqua(slug))
		default:
			return errors.Errorf("failed to delete function %s: %s", slug, string(resp.Body))
		}
	}

	return nil
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
