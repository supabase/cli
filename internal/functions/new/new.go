package new

import (
	"context"
	_ "embed"
	"fmt"
	"html/template"
	"os"
	"path/filepath"

	"github.com/go-errors/errors"
	"github.com/spf13/afero"
	_init "github.com/supabase/cli/internal/init"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/internal/utils/flags"
)

var (
	//go:embed templates/index.ts
	indexEmbed string
	//go:embed templates/deno.json
	denoEmbed string
	//go:embed templates/.npmrc
	npmrcEmbed string
	//go:embed templates/config.toml
	configEmbed string

	indexTemplate  = template.Must(template.New("index").Parse(indexEmbed))
	configTemplate = template.Must(template.New("config").Parse(configEmbed))
)

type indexConfig struct {
	URL   string
	Token string
}

func Run(ctx context.Context, slug string, fsys afero.Fs) error {
	// 1. Sanity checks.
	if err := utils.ValidateFunctionSlug(slug); err != nil {
		return err
	}
	// Check if this is the first function before creating the new one
	isFirstFunction := isFirstFunctionCreation(fsys)

	// 2. Create new function.
	funcDir := filepath.Join(utils.FunctionsDir, slug)
	if err := utils.MkdirIfNotExistFS(fsys, funcDir); err != nil {
		return err
	}
	// Load config if available
	if err := flags.LoadConfig(fsys); err != nil {
		fmt.Fprintln(utils.GetDebugLogger(), err)
	}
	if err := createEntrypointFile(slug, fsys); err != nil {
		return err
	}
	if err := appendConfigFile(slug, fsys); err != nil {
		return err
	}
	// 3. Create optional files
	if err := afero.WriteFile(fsys, filepath.Join(funcDir, "deno.json"), []byte(denoEmbed), 0644); err != nil {
		return errors.Errorf("failed to create deno.json config: %w", err)
	}
	if err := afero.WriteFile(fsys, filepath.Join(funcDir, ".npmrc"), []byte(npmrcEmbed), 0644); err != nil {
		return errors.Errorf("failed to create .npmrc config: %w", err)
	}
	fmt.Println("Created new Function at " + utils.Bold(funcDir))

	// 4. If this is the first function, prompt for IDE settings
	if isFirstFunction {
		if err := promptForIDESettings(ctx, fsys); err != nil {
			return err
		}
	}
	return nil
}

// isFirstFunctionCreation checks if this is the first function being created.
// Returns true if the functions directory doesn't exist or is empty.
func isFirstFunctionCreation(fsys afero.Fs) bool {
	entries, err := afero.ReadDir(fsys, utils.FunctionsDir)
	if err != nil {
		// Directory doesn't exist, this is the first function
		return true
	}
	// Check if there are any subdirectories (existing functions)
	for _, entry := range entries {
		if entry.IsDir() {
			return false
		}
	}
	return true
}

// promptForIDESettings prompts the user to generate IDE settings for Deno development.
func promptForIDESettings(ctx context.Context, fsys afero.Fs) error {
	console := utils.NewConsole()
	if isVscode, err := console.PromptYesNo(ctx, "Generate VS Code settings for Deno?", true); err != nil {
		return err
	} else if isVscode {
		return _init.WriteVscodeConfig(fsys)
	}
	if isIntelliJ, err := console.PromptYesNo(ctx, "Generate IntelliJ IDEA settings for Deno?", false); err != nil {
		return err
	} else if isIntelliJ {
		return _init.WriteIntelliJConfig(fsys)
	}
	return nil
}

func createEntrypointFile(slug string, fsys afero.Fs) error {
	entrypointPath := filepath.Join(utils.FunctionsDir, slug, "index.ts")
	f, err := fsys.OpenFile(entrypointPath, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0644)
	if err != nil {
		return errors.Errorf("failed to create entrypoint: %w", err)
	}
	defer f.Close()
	if err := indexTemplate.Option("missingkey=error").Execute(f, indexConfig{
		URL:   utils.GetApiUrl("/functions/v1/" + slug),
		Token: utils.Config.Auth.AnonKey.Value,
	}); err != nil {
		return errors.Errorf("failed to write entrypoint: %w", err)
	}
	return nil
}

func appendConfigFile(slug string, fsys afero.Fs) error {
	if _, exists := utils.Config.Functions[slug]; exists {
		fmt.Fprintf(os.Stderr, "[functions.%s] is already declared in %s\n", slug, utils.Bold(utils.ConfigPath))
		return nil
	}
	f, err := fsys.OpenFile(utils.ConfigPath, os.O_WRONLY|os.O_CREATE|os.O_APPEND, 0644)
	if err != nil {
		return errors.Errorf("failed to append config: %w", err)
	}
	defer f.Close()
	if err := configTemplate.Option("missingkey=error").Execute(f, slug); err != nil {
		return errors.Errorf("failed to append template: %w", err)
	}
	return nil
}
