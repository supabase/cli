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
	indexEmbed    string
	indexTemplate = template.Must(template.New("indexl").Parse(indexEmbed))
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
		path := filepath.Join(funcDir, "index.ts")
		f, err := fsys.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0644)
		if err != nil {
			return errors.Errorf("failed to create function entrypoint: %w", err)
		}
		defer f.Close()
		// Templatize index.ts by config.toml if available
		if err := utils.LoadConfigFS(fsys); err != nil {
			utils.CmdSuggestion = ""
		}
		config := indexConfig{
			URL:   utils.GetApiUrl("/functions/v1/" + slug),
			Token: utils.Config.Auth.AnonKey,
		}
		if err := indexTemplate.Option("missingkey=error").Execute(f, config); err != nil {
			return errors.Errorf("failed to initialise function entrypoint: %w", err)
		}
	}

	fmt.Println("Created new Function at " + utils.Bold(funcDir))
	return nil
}
