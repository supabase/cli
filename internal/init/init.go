package init

import (
	_ "embed"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"

	"golang.org/x/exp/maps"

	"github.com/spf13/afero"
	"github.com/supabase/cli/internal/utils"
)

var (
	//go:embed templates/.gitignore
	initGitignore []byte
	//go:embed templates/.vscode/extensions.json
	vscodeExtensions string
	//go:embed templates/.vscode/settings.json
	vscodeSettings string

	errAlreadyInitialized = errors.New("Project already initialized. Remove " + utils.Bold(utils.ConfigPath) + " to reinitialize.")
)

func Run(fsys afero.Fs, createVscodeSettings *bool, useOrioleDB bool) error {
	// Sanity checks.
	{
		if _, err := fsys.Stat(utils.ConfigPath); err == nil {
			return errAlreadyInitialized
		} else if !errors.Is(err, os.ErrNotExist) {
			return err
		}
	}

	// 1. Write `config.toml`.
	if err := utils.InitConfig(utils.InitParams{UseOrioleDB: useOrioleDB}, fsys); err != nil {
		return err
	}

	// 2. Create `seed.sql`.
	if _, err := fsys.Create(utils.SeedDataPath); err != nil {
		return err
	}

	// 3. Append to `.gitignore`.
	if utils.IsGitRepo() {
		if err := updateGitIgnore(utils.GitIgnorePath, fsys); err != nil {
			return err
		}
	}

	// 4. Generate VS Code settings.
	if createVscodeSettings != nil {
		if *createVscodeSettings {
			return writeVscodeConfig(fsys)
		}
	} else {
		if isVscode := utils.PromptYesNo("Generate VS Code settings for Deno?", false, os.Stdin); isVscode {
			return writeVscodeConfig(fsys)
		}
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
		return err
	}

	f, err := fsys.OpenFile(ignorePath, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0644)
	if err != nil {
		return err
	}
	defer f.Close()

	if _, err := f.Write(append(contents, initGitignore...)); err != nil {
		return err
	}

	return nil
}

func updateJsonFile(path string, template string, fsys afero.Fs) error {
	// Open our jsonFile
	jsonFile, err := os.Open(path)
	// if we os.Open returns an error then handle it
	if err != nil {
		if err := afero.WriteFile(fsys, path, []byte(template), 0644); err != nil {
			return err
		}
		return nil
	}
	defer jsonFile.Close()

	// Parse and unmarshal JSON file.
	byteValue, _ := io.ReadAll(jsonFile)
	var userSettings map[string]interface{}
	err = json.Unmarshal(byteValue, &userSettings)
	if err != nil {
		return fmt.Errorf("failed to parse user settings: %w", err)
	}
	var templateSettings map[string]interface{}
	err = json.Unmarshal([]byte(template), &templateSettings)
	if err != nil {
		return fmt.Errorf("failed to parse template settings: %w", err)
	}
	// Merge template into user settings.
	maps.Copy(userSettings, templateSettings)
	jsonString, err := json.MarshalIndent(userSettings, "", "  ")
	if err != nil {
		return err
	}
	if err := afero.WriteFile(fsys, path, jsonString, 0644); err != nil {
		return err
	}

	return nil
}

func writeVscodeConfig(fsys afero.Fs) error {
	{
		// Create VS Code settings for Deno.
		cwd, err := os.Getwd()
		if err != nil {
			return err
		}
		vscodeDir := filepath.Join(cwd, ".vscode")
		if err := utils.MkdirIfNotExistFS(fsys, vscodeDir); err != nil {
			return err
		}
		if err := updateJsonFile(filepath.Join(vscodeDir, "extensions.json"), vscodeExtensions, fsys); err != nil {
			return err
		}
		if err := updateJsonFile(filepath.Join(vscodeDir, "settings.json"), vscodeSettings, fsys); err != nil {
			return err
		}
		fmt.Println("Generated VS Code settings in " + utils.Aqua(filepath.Base(vscodeDir)+"/settings.json") + ". Please install the recommended extension!")
	}
	return nil
}
