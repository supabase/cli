package onboarding

import (
	"github.com/spf13/afero"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/internal/utils/flags"
)

// DetectState checks the current project state
func DetectState(fsys afero.Fs) *State {
	return &State{
		ConfigExists:  ConfigExists(fsys),
		ProjectLinked: ProjectLinked(fsys),
		HasMigrations: HasMigrations(fsys),
		HasFunctions:  HasFunctions(fsys),
	}
}

// ConfigExists checks if supabase/config.toml exists
func ConfigExists(fsys afero.Fs) bool {
	exists, _ := afero.Exists(fsys, utils.ConfigPath)
	return exists
}

// ProjectLinked checks if project is linked to remote
func ProjectLinked(fsys afero.Fs) bool {
	err := flags.LoadProjectRef(fsys)
	return err == nil
}

// HasMigrations checks if local migrations exist
func HasMigrations(fsys afero.Fs) bool {
	exists, err := afero.DirExists(fsys, utils.MigrationsDir)
	if err != nil || !exists {
		return false
	}
	entries, err := afero.ReadDir(fsys, utils.MigrationsDir)
	if err != nil {
		return false
	}
	// Check for .sql files
	for _, entry := range entries {
		if !entry.IsDir() && len(entry.Name()) > 4 && entry.Name()[len(entry.Name())-4:] == ".sql" {
			return true
		}
	}
	return false
}

// HasFunctions checks if local functions exist
func HasFunctions(fsys afero.Fs) bool {
	exists, err := afero.DirExists(fsys, utils.FunctionsDir)
	if err != nil || !exists {
		return false
	}
	entries, err := afero.ReadDir(fsys, utils.FunctionsDir)
	if err != nil {
		return false
	}
	// Check for function directories (excluding import_map.json and .env)
	for _, entry := range entries {
		if entry.IsDir() {
			return true
		}
	}
	return false
}
