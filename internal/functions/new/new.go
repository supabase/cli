package new

import (
	"context"
	_ "embed"
	"fmt"
	"html/template"
	"os"
	"path/filepath"
	"strings"

	"github.com/go-errors/errors"
	"github.com/spf13/afero"
	"github.com/supabase/cli/internal/utils"
)

var (
	//go:embed templates/index.ts
	indexEmbed    string
	indexTemplate = template.Must(template.New("indexl").Parse(indexEmbed))

	//go:embed templates/index.js
	indexJsEmbed    string
	indexJsTemplate = template.Must(template.New("indexjs").Parse(indexJsEmbed))
)

type indexConfig struct {
	URL   string
	Token string
}

func Run(ctx context.Context, slug string, useJs bool, fsys afero.Fs) error {
	// 1. Sanity checks.
	funcDir := filepath.Join(utils.FunctionsDir, slug)
	{
		if err := utils.ValidateFunctionSlug(slug); err != nil {
			return err
		}
	}
	if err := utils.LoadConfigFS(fsys); err != nil {
		utils.CmdSuggestion = ""
	}

	// 2. Config
	if !useJs {
		defaultLanguage := utils.Config.EdgeRuntime.DefaultLanguage
		if strings.ToLower(defaultLanguage) == "javascript" {
			useJs = true
		}
	}

	// 3. Create new function.
	{
		if err := utils.MkdirIfNotExistFS(fsys, funcDir); err != nil {
			return err
		}

		path := filepath.Join(funcDir, "index.ts")
		if useJs {
			path = filepath.Join(funcDir, "index.js")
		}
		f, err := fsys.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0644)
		if err != nil {
			return errors.Errorf("failed to create function entrypoint: %w", err)
		}
		defer f.Close()
		// Templatize index.ts by config.toml if available
		config := indexConfig{
			URL:   utils.GetApiUrl("/functions/v1/" + slug),
			Token: utils.Config.Auth.AnonKey,
		}
		if useJs {
			if err := indexJsTemplate.Option("missingkey=error").Execute(f, config); err != nil {
				return errors.Errorf("failed to initialise function entrypoint: %w", err)
			}
		} else {
			if err := indexTemplate.Option("missingkey=error").Execute(f, config); err != nil {
				return errors.Errorf("failed to initialise function entrypoint: %w", err)
			}
		}
	}

	fmt.Println("Created new Function at " + utils.Bold(funcDir))
	return nil
}
