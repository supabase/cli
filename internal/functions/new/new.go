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
	"github.com/supabase/cli/internal/utils"
)

var (
	//go:embed templates/index.ts
	indexEmbed string
	//go:embed templates/deno.jsonc
	denoEmbed string
	//go:embed templates/.npmrc
	npmrcEmbed string

	indexTemplate = template.Must(template.New("index").Parse(indexEmbed))
)

type indexConfig struct {
	URL   string
	Token string
}

func Run(ctx context.Context, slug string, fsys afero.Fs) error {
	// 1. Sanity checks.
	funcDir := filepath.Join(utils.FunctionsDir, slug)
	{
		if err := utils.ValidateFunctionSlug(slug); err != nil {
			return err
		}
	}

	// 2. Create new function.
	{
		if err := utils.MkdirIfNotExistFS(fsys, funcDir); err != nil {
			return err
		}

		// Load config if available
		if err := utils.LoadConfigFS(fsys); err != nil {
			utils.CmdSuggestion = ""
		}

		if err := createTemplateFile(fsys, filepath.Join(funcDir, "index.ts"), indexTemplate, indexConfig{
			URL:   utils.GetApiUrl("/functions/v1/" + slug),
			Token: utils.Config.Auth.AnonKey,
		}); err != nil {
			return errors.Errorf("failed to create function entrypoint: %w", err)
		}

		if err := afero.WriteFile(fsys, filepath.Join(funcDir, "deno.jsonc"), []byte(denoEmbed), 0644); err != nil {
			return errors.Errorf("failed to create deno.jsonc config: %w", err)
		}

		if err := afero.WriteFile(fsys, filepath.Join(funcDir, ".npmrc"), []byte(npmrcEmbed), 0644); err != nil {
			return errors.Errorf("failed to create .npmrc config: %w", err)
		}
	}

	fmt.Println("Created new Function at " + utils.Bold(funcDir))
	return nil
}

func createTemplateFile(fsys afero.Fs, path string, tmpl *template.Template, data interface{}) error {
	f, err := fsys.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0644)
	if err != nil {
		return err
	}
	defer f.Close()
	return tmpl.Option("missingkey=error").Execute(f, data)
}
