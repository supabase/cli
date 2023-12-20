package init

import (
	_ "embed"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"

	"github.com/go-errors/errors"
	"github.com/spf13/afero"
	"github.com/supabase/cli/internal/utils"
)

var (
	vscodeDir      = ".vscode"
	extensionsPath = filepath.Join(vscodeDir, "extensions.json")
	settingsPath   = filepath.Join(vscodeDir, "settings.json")

	//go:embed templates/.gitignore
	initGitignore []byte
	//go:embed templates/.vscode/extensions.json
	vscodeExtensions string
	//go:embed templates/.vscode/settings.json
	vscodeSettings string

	errAlreadyInitialized = errors.Errorf("Project already initialized. Remove %s to reinitialize.", utils.Bold(utils.ConfigPath))
)

func Run(fsys afero.Fs, createVscodeSettings *bool, useOrioleDB bool) error {
	// Sanity checks.
	{
		if _, err := fsys.Stat(utils.ConfigPath); err == nil {
			return errors.New(errAlreadyInitialized)
		} else if !errors.Is(err, os.ErrNotExist) {
			return errors.Errorf("failed to read config file: %w", err)
		}
	}

	// 1. Write `config.toml`.
	if err := utils.InitConfig(utils.InitParams{UseOrioleDB: useOrioleDB}, fsys); err != nil {
		return err
	}

	// 2. Create `seed.sql`.
	if _, err := fsys.Create(utils.SeedDataPath); err != nil {
		return errors.Errorf("failed to create seed file: %w", err)
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

type VSCodeSettings map[string]interface{}

func loadUserSettings(path string, fsys afero.Fs) (VSCodeSettings, error) {
	// Open our jsonFile
	jsonFile, err := fsys.Open(path)
	if err != nil {
		return nil, errors.Errorf("failed to load settings file: %w", err)
	}
	defer jsonFile.Close()
	// Parse and unmarshal JSON file.
	var userSettings VSCodeSettings
	dec := json.NewDecoder(jsonFile)
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

func writeVscodeConfig(fsys afero.Fs) error {
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
	fmt.Println("Generated VS Code settings in " + utils.Bold(settingsPath) + ". Please install the recommended extension!")
	return nil
}
