package declarative

import (
	"fmt"
	"os"
	"path/filepath"
	"time"

	"github.com/spf13/afero"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/pkg/migration"
)

const (
	debugDirPrefix = "debug"
	debugLayout    = "20060102-150405"
)

// DebugBundle collects diagnostic artifacts when a declarative operation fails.
type DebugBundle struct {
	ID           string   // timestamp-based unique ID (e.g. "20240414-044403")
	SourceRef    string   // path to source catalog
	TargetRef    string   // path to target catalog
	MigrationSQL string   // generated migration (if available)
	Error        error    // the error that occurred
	Migrations   []string // list of local migration files
}

// SaveDebugBundle writes diagnostic artifacts to .temp/pgdelta/debug/<ID>/ and
// returns the directory path.
func SaveDebugBundle(bundle DebugBundle, fsys afero.Fs) (string, error) {
	if len(bundle.ID) == 0 {
		bundle.ID = time.Now().UTC().Format(debugLayout)
	}
	debugDir := filepath.Join(utils.TempDir, pgDeltaTempDir, debugDirPrefix, bundle.ID)
	if err := utils.MkdirIfNotExistFS(fsys, debugDir); err != nil {
		return "", fmt.Errorf("failed to create debug directory: %w", err)
	}

	// Copy source catalog if available
	if len(bundle.SourceRef) > 0 {
		if data, err := afero.ReadFile(fsys, bundle.SourceRef); err == nil {
			_ = utils.WriteFile(filepath.Join(debugDir, "source-catalog.json"), data, fsys)
		}
	}

	// Copy target catalog if available
	if len(bundle.TargetRef) > 0 {
		if data, err := afero.ReadFile(fsys, bundle.TargetRef); err == nil {
			_ = utils.WriteFile(filepath.Join(debugDir, "target-catalog.json"), data, fsys)
		}
	}

	// Save generated migration if available
	if len(bundle.MigrationSQL) > 0 {
		_ = utils.WriteFile(filepath.Join(debugDir, "generated-migration.sql"), []byte(bundle.MigrationSQL), fsys)
	}

	// Save error details
	if bundle.Error != nil {
		_ = utils.WriteFile(filepath.Join(debugDir, "error.txt"), []byte(bundle.Error.Error()), fsys)
	}

	// Copy migration files
	if len(bundle.Migrations) > 0 {
		migrationsDir := filepath.Join(debugDir, "migrations")
		if err := utils.MkdirIfNotExistFS(fsys, migrationsDir); err == nil {
			for _, name := range bundle.Migrations {
				src := filepath.Join(utils.MigrationsDir, name)
				if data, err := afero.ReadFile(fsys, src); err == nil {
					_ = utils.WriteFile(filepath.Join(migrationsDir, name), data, fsys)
				}
			}
		}
	}

	return debugDir, nil
}

// PrintDebugBundleMessage prints instructions for reporting an issue after
// saving a debug bundle.
func PrintDebugBundleMessage(debugDir string) {
	fmt.Fprintln(os.Stderr)
	if len(debugDir) > 0 {
		fmt.Fprintln(os.Stderr, "Debug information saved to "+utils.Bold(debugDir))
		fmt.Fprintln(os.Stderr)
	}
	fmt.Fprintln(os.Stderr, "To report this issue, you can:")
	fmt.Fprintln(os.Stderr, "  1. Open an issue at https://github.com/supabase/pg-toolbelt/issues")
	fmt.Fprintln(os.Stderr, "     Attach the files from the debug folder above.")
	fmt.Fprintln(os.Stderr, "  2. Open a support ticket at https://supabase.com/dashboard/support")
	fmt.Fprintln(os.Stderr, "     (only visible to Supabase employees)")
	fmt.Fprintln(os.Stderr)
	fmt.Fprintln(os.Stderr, utils.Yellow("WARNING: The debug folder may contain sensitive information about your"))
	fmt.Fprintln(os.Stderr, utils.Yellow("database schema, including table structures, function definitions, and role"))
	fmt.Fprintln(os.Stderr, utils.Yellow("configurations. Review the contents carefully before sharing publicly."))
	fmt.Fprintln(os.Stderr, utils.Yellow("If unsure, prefer opening a support ticket (option 2) instead."))
}

// CollectMigrationsList returns a list of local migration filenames for
// inclusion in a debug bundle.
func CollectMigrationsList(fsys afero.Fs) []string {
	migrations, err := migration.ListLocalMigrations(utils.MigrationsDir, afero.NewIOFS(fsys))
	if err != nil {
		return nil
	}
	// Strip directory prefix to return just filenames
	for i, m := range migrations {
		migrations[i] = filepath.Base(m)
	}
	return migrations
}
