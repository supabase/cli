package init

import (
	"bytes"
	"context"
	_ "embed"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"

	"github.com/go-errors/errors"
	"github.com/spf13/afero"
	"github.com/supabase/cli/internal/utils"
	"github.com/tidwall/jsonc"
)

var (
	vscodeDir      = ".vscode"
	extensionsPath = filepath.Join(vscodeDir, "extensions.json")
	settingsPath   = filepath.Join(vscodeDir, "settings.json")
	intellijDir    = ".idea"
	denoPath       = filepath.Join(intellijDir, "deno.xml")

	//go:embed templates/.gitignore
	initGitignore []byte
	//go:embed templates/.vscode/extensions.json
	vscodeExtensions string
	//go:embed templates/.vscode/settings.json
	vscodeSettings string
	//go:embed templates/.idea/deno.xml
	intelliJDeno string
)

func Run(ctx context.Context, fsys afero.Fs, interactive bool, params utils.InitParams) error {
	// 1. Write `config.toml`.
	if err := utils.InitConfig(params, fsys); err != nil {
		if errors.Is(err, os.ErrExist) {
			utils.CmdSuggestion = fmt.Sprintf("Run %s to overwrite existing config file.", utils.Aqua("supabase init --force"))
		}
		return err
	}

	// 2. Append to `.gitignore`.
	if utils.IsGitRepo() {
		if err := updateGitIgnore(utils.GitIgnorePath, fsys); err != nil {
			return err
		}
	}

	// 3. Prompt for IDE settings in interactive mode.
	if interactive {
		if err := PromptForIDESettings(ctx, fsys); err != nil {
			return err
		}
	}
	return nil
}

// PromptForIDESettings prompts the user to generate IDE settings for Deno.
func PromptForIDESettings(ctx context.Context, fsys afero.Fs) error {
	console := utils.NewConsole()
	if isVscode, err := console.PromptYesNo(ctx, "Generate VS Code settings for Deno?", true); err != nil {
		return err
	} else if isVscode {
		return WriteVscodeConfig(fsys)
	}
	if isIntelliJ, err := console.PromptYesNo(ctx, "Generate IntelliJ IDEA settings for Deno?", false); err != nil {
		return err
	} else if isIntelliJ {
		return WriteIntelliJConfig(fsys)
	}
	return nil
}

func updateGitIgnore(ignorePath string, fsys afero.Fs) error {
	var contents []byte

	if contained, err := afero.FileContainsBytes(fsys, ignorePath, initGitignore); contained {
		return nil
	} else if err == nil {
		// Add a line break when appending
		contents = append(contents, '\n')
	} else if !errors.Is(err, os.ErrNotExist) {
		return errors.Errorf("failed to read git ignore file: %w", err)
	}

	f, err := fsys.OpenFile(ignorePath, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0644)
	if err != nil {
		return errors.Errorf("failed to create git ignore file: %w", err)
	}
	defer f.Close()

	if _, err := f.Write(append(contents, initGitignore...)); err != nil {
		return errors.Errorf("failed to write git ignore file: %w", err)
	}

	return nil
}

type VSCodeSettings map[string]any

func loadUserSettings(path string, fsys afero.Fs) (VSCodeSettings, error) {
	data, err := afero.ReadFile(fsys, path)
	if err != nil {
		return nil, errors.Errorf("failed to load settings file: %w", err)
	}
	data = jsonc.ToJSONInPlace(data)
	// Parse and unmarshal JSON file.
	var userSettings VSCodeSettings
	dec := json.NewDecoder(bytes.NewReader(data))
	if err := dec.Decode(&userSettings); err != nil {
		return nil, errors.Errorf("failed to parse settings: %w", err)
	}
	return userSettings, nil
}

func saveUserSettings(path string, settings VSCodeSettings, fsys afero.Fs) error {
	// Open our jsonFile
	jsonFile, err := fsys.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0644)
	if err != nil {
		return errors.Errorf("failed to create settings file: %w", err)
	}
	defer jsonFile.Close()
	// Marshal JSON to file.
	enc := json.NewEncoder(jsonFile)
	enc.SetIndent("", "  ")
	if err := enc.Encode(settings); err != nil {
		return errors.Errorf("failed to save settings: %w", err)
	}
	return nil
}

func updateJsonFile(path string, template string, fsys afero.Fs) error {
	userSettings, err := loadUserSettings(path, fsys)
	if errors.Is(err, os.ErrNotExist) || errors.Is(err, io.EOF) {
		return afero.WriteFile(fsys, path, []byte(template), 0644)
	} else if err != nil {
		return err
	}
	// Merge template into user settings.
	if err := json.Unmarshal([]byte(template), &userSettings); err != nil {
		return errors.Errorf("failed to copy template: %w", err)
	}
	return saveUserSettings(path, userSettings, fsys)
}

func WriteVscodeConfig(fsys afero.Fs) error {
	// Create VS Code settings for Deno.
	if err := utils.MkdirIfNotExistFS(fsys, vscodeDir); err != nil {
		return err
	}
	if err := updateJsonFile(extensionsPath, vscodeExtensions, fsys); err != nil {
		return err
	}
	if err := updateJsonFile(settingsPath, vscodeSettings, fsys); err != nil {
		return err
	}
	fmt.Println("Generated VS Code settings in " + utils.Bold(settingsPath) + ".")
	fmt.Println("Please install the Deno extension for VS Code: " + utils.Bold("https://marketplace.visualstudio.com/items?itemName=denoland.vscode-deno"))
	return nil
}

func WriteIntelliJConfig(fsys afero.Fs) error {
	if err := utils.WriteFile(denoPath, []byte(intelliJDeno), fsys); err != nil {
		return err
	}
	fmt.Println("Generated IntelliJ settings in " + utils.Bold(denoPath) + ".")
	fmt.Println("Please install the Deno plugin for IntelliJ: " + utils.Bold("https://plugins.jetbrains.com/plugin/14382-deno"))
	return nil
}
