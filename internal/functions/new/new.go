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
	"github.com/supabase/cli/internal/functions/deploy"
	_init "github.com/supabase/cli/internal/init"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/internal/utils/flags"
)

type AuthAccessMode string

const (
	AuthAccessModeAlways AuthAccessMode = "always"
	AuthAccessModeApiKey AuthAccessMode = "apikey"
	AuthAccessModeUser   AuthAccessMode = "user"
)

var (
	//go:embed templates/index_always_access.ts
	indexAuthAlwaysEmbed string
	//go:embed templates/index_apikey_access.ts
	indexAuthApiKeyEmbed string
	//go:embed templates/index_user_access.ts
	indexAuthUserEmbed string

	//go:embed templates/deno.json
	denoEmbed string
	//go:embed templates/.npmrc
	npmrcEmbed string
	//go:embed templates/config.toml
	configEmbed string

	indexAuthTemplates = map[AuthAccessMode]*template.Template{
		AuthAccessModeAlways: template.Must(template.New("index").Parse(indexAuthAlwaysEmbed)),
		AuthAccessModeApiKey: template.Must(template.New("index").Parse(indexAuthApiKeyEmbed)),
		AuthAccessModeUser:   template.Must(template.New("index").Parse(indexAuthUserEmbed)),
	}

	configTemplate = template.Must(template.New("config").Parse(configEmbed))
)

type indexConfig struct {
	URL            string
	PublishableKey string
}

type functionConfig struct {
	Slug      string
	VerifyJWT bool
}

func Run(ctx context.Context, slug string, authMode AuthAccessMode, fsys afero.Fs) error {
	// 1. Sanity checks.
	if err := utils.ValidateFunctionSlug(slug); err != nil {
		return err
	}
	// Check if this is the first function being created
	existingSlugs, err := deploy.GetFunctionSlugs(fsys)
	if err != nil {
		fmt.Fprintln(utils.GetDebugLogger(), err)
	}
	isFirstFunction := len(existingSlugs) == 0

	// 2. Create new function.
	funcDir := filepath.Join(utils.FunctionsDir, slug)
	if err := utils.MkdirIfNotExistFS(fsys, funcDir); err != nil {
		return err
	}
	// Load config if available
	if err := flags.LoadConfig(fsys); err != nil {
		fmt.Fprintln(utils.GetDebugLogger(), err)
	}
	if err := createEntrypointFile(slug, authMode, fsys); err != nil {
		return err
	}
	verifyJWT := authMode == AuthAccessModeUser
	if err := appendConfigFile(slug, verifyJWT, fsys); err != nil {
		return err
	}
	// 3. Create optional files
	if err := afero.WriteFile(fsys, filepath.Join(funcDir, "deno.json"), []byte(denoEmbed), 0o644); err != nil {
		return errors.Errorf("failed to create deno.json config: %w", err)
	}
	if err := afero.WriteFile(fsys, filepath.Join(funcDir, ".npmrc"), []byte(npmrcEmbed), 0o644); err != nil {
		return errors.Errorf("failed to create .npmrc config: %w", err)
	}
	fmt.Println("Created new Function at " + utils.Bold(funcDir))

	if isFirstFunction {
		if err := _init.PromptForIDESettings(ctx, fsys); err != nil {
			return err
		}
	}
	return nil
}

func createEntrypointFile(slug string, authMode AuthAccessMode, fsys afero.Fs) error {
	entrypointPath := filepath.Join(utils.FunctionsDir, slug, "index.ts")
	f, err := fsys.OpenFile(entrypointPath, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o644)
	if err != nil {
		return errors.Errorf("failed to create entrypoint: %w", err)
	}
	defer f.Close()
	indexTemplate, hasTemplate := indexAuthTemplates[authMode]
	if !hasTemplate {
		return errors.Errorf("failed to write entrypoint: '%v' is not a valid template", authMode)
	}
	if err := indexTemplate.Option("missingkey=error").Execute(f, indexConfig{
		URL:            utils.GetApiUrl("/functions/v1/" + slug),
		PublishableKey: utils.Config.Auth.PublishableKey.Value,
	}); err != nil {
		return errors.Errorf("failed to write entrypoint: %w", err)
	}
	return nil
}

func appendConfigFile(slug string, verifyJWT bool, fsys afero.Fs) error {
	if _, exists := utils.Config.Functions[slug]; exists {
		fmt.Fprintf(os.Stderr, "[functions.%s] is already declared in %s\n", slug, utils.Bold(utils.ConfigPath))
		return nil
	}
	f, err := fsys.OpenFile(utils.ConfigPath, os.O_WRONLY|os.O_CREATE|os.O_APPEND, 0o644)
	if err != nil {
		return errors.Errorf("failed to append config: %w", err)
	}
	defer f.Close()
	if err := configTemplate.Option("missingkey=error").Execute(f, functionConfig{
		Slug:      slug,
		VerifyJWT: verifyJWT,
	}); err != nil {
		return errors.Errorf("failed to append template: %w", err)
	}
	return nil
}
