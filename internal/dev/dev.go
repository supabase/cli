package dev

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"

	"github.com/go-errors/errors"
	"github.com/spf13/afero"
	"github.com/supabase/cli/internal/start"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/internal/utils/flags"
)

// Run starts the dev session
func Run(ctx context.Context, fsys afero.Fs) error {
	// Load config first
	if err := flags.LoadConfig(fsys); err != nil {
		return err
	}

	// Ensure local database is running
	if err := ensureDbRunning(ctx, fsys); err != nil {
		return err
	}

	// Create and run the dev session
	session := NewSession(ctx, fsys)
	return session.Run()
}

// ensureDbRunning starts the local database if it's not already running
func ensureDbRunning(ctx context.Context, fsys afero.Fs) error {
	if err := utils.AssertSupabaseDbIsRunning(); err == nil {
		fmt.Fprintln(os.Stderr, "Using existing local database")
		return nil
	} else if !errors.Is(err, utils.ErrNotRunning) {
		return err
	}

	fmt.Fprintln(os.Stderr, "Starting local database...")
	return start.Run(ctx, fsys, nil, false)
}

// Session manages the dev mode lifecycle
type Session struct {
	ctx    context.Context
	cancel context.CancelFunc
	fsys   afero.Fs
	dirty  bool // tracks whether schema changes have been applied
}

// NewSession creates a new dev session
func NewSession(ctx context.Context, fsys afero.Fs) *Session {
	ctx, cancel := context.WithCancel(ctx)
	return &Session{
		ctx:    ctx,
		cancel: cancel,
		fsys:   fsys,
		dirty:  false,
	}
}


// Run starts the dev session main loop
func (s *Session) Run() error {
	schemasConfig := &utils.Config.Dev.Schemas

	// Check if schemas workflow is enabled
	if !schemasConfig.IsEnabled() {
		fmt.Fprintln(os.Stderr, "[dev] Schema workflow is disabled in config")
		fmt.Fprintln(os.Stderr, "[dev] Press Ctrl+C to stop")

		// Set up signal handling for graceful shutdown
		sigCh := make(chan os.Signal, 1)
		signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
		<-sigCh
		fmt.Fprintln(os.Stderr)
		fmt.Fprintln(os.Stderr, "[dev] Stopping dev session...")
		return nil
	}

	// Get watch globs from config
	watchGlobs := schemasConfig.Watch
	if len(watchGlobs) == 0 {
		// Fallback to default if not configured
		watchGlobs = []string{"schemas/**/*.sql"}
	}

	// Validate config on startup
	s.validateConfig()

	// Create schemas directory if using default pattern and it doesn't exist
	if exists, err := afero.DirExists(s.fsys, utils.SchemasDir); err != nil {
		return errors.Errorf("failed to check schemas directory: %w", err)
	} else if !exists {
		fmt.Fprintf(os.Stderr, "[dev] Creating %s directory...\n", utils.Aqua(utils.SchemasDir))
		if err := s.fsys.MkdirAll(utils.SchemasDir, 0755); err != nil {
			return errors.Errorf("failed to create schemas directory: %w", err)
		}
	}

	// Set up signal handling
	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)

	// Get seed globs from [db.seed] config (already resolved to absolute paths)
	seedConfig := &utils.Config.Dev.Seed
	var seedGlobs []string
	if seedConfig.IsEnabled() && utils.Config.Db.Seed.Enabled {
		seedGlobs = utils.Config.Db.Seed.SqlPaths
	}

	// Display configuration
	fmt.Fprintln(os.Stderr)
	fmt.Fprintf(os.Stderr, "[dev] Watching: %v\n", watchGlobs)
	if schemasConfig.OnChange != "" {
		fmt.Fprintf(os.Stderr, "[dev] On change: %s\n", utils.Aqua(schemasConfig.OnChange))
	} else {
		fmt.Fprintf(os.Stderr, "[dev] On change: %s\n", utils.Aqua("(internal differ)"))
	}
	if schemasConfig.Types != "" {
		fmt.Fprintf(os.Stderr, "[dev] Types output: %s\n", utils.Aqua(schemasConfig.Types))
	}
	if seedConfig.IsEnabled() {
		if seedConfig.OnChange != "" {
			fmt.Fprintf(os.Stderr, "[dev] Seed: %s\n", utils.Aqua(seedConfig.OnChange))
		} else if utils.Config.Db.Seed.Enabled && len(utils.Config.Db.Seed.SqlPaths) > 0 {
			fmt.Fprintf(os.Stderr, "[dev] Seed: %s\n", utils.Aqua("(internal)"))
		}
	}
	fmt.Fprintln(os.Stderr, "[dev] Press Ctrl+C to stop")
	fmt.Fprintln(os.Stderr)

	// Create the schema watcher
	watcher, err := NewSchemaWatcher(s.fsys, watchGlobs, seedGlobs)
	if err != nil {
		return err
	}
	defer watcher.Close()

	// Start the watcher
	go watcher.Start()

	// Apply initial schema state
	fmt.Fprintln(os.Stderr, "[dev] Applying initial schema state...")
	if err := s.applySchemaChanges(); err != nil {
		fmt.Fprintf(os.Stderr, "[dev] %s %s\n", utils.Yellow("Warning:"), err.Error())
	} else {
		fmt.Fprintln(os.Stderr, "[dev] Initial sync complete")
	}

	// Run initial seed (after schema sync)
	if seedConfig.IsEnabled() {
		fmt.Fprintln(os.Stderr, "[dev] Running initial seed...")
		if err := s.runSeed(); err != nil {
			fmt.Fprintf(os.Stderr, "[dev] %s %s\n", utils.Yellow("Warning:"), err.Error())
		} else {
			fmt.Fprintln(os.Stderr, "[dev] Initial seed complete")
		}
	}

	fmt.Fprintln(os.Stderr, "[dev] Watching for changes...")

	// Main event loop
	for {
		select {
		case <-s.ctx.Done():
			CleanupShadow(s.ctx)
			return s.ctx.Err()
		case <-sigCh:
			fmt.Fprintln(os.Stderr)
			fmt.Fprintln(os.Stderr, "[dev] Stopping dev session...")
			CleanupShadow(s.ctx)
			s.showDirtyWarning()
			return nil
		case <-watcher.RestartCh:
			// Check if seeds changed - if so, reseed the database
			if watcher.SeedsChanged() {
				fmt.Fprintln(os.Stderr, "[dev] Reseeding database...")
				if err := s.runSeed(); err != nil {
					fmt.Fprintf(os.Stderr, "[dev] %s %s\n", utils.Red("Error:"), err.Error())
				} else {
					fmt.Fprintln(os.Stderr, "[dev] Reseed complete")
				}
				fmt.Fprintln(os.Stderr, "[dev] Watching for changes...")
				continue
			}

			// Check if migrations changed - if so, just invalidate the shadow template
			// We do NOT auto-apply migrations because:
			// 1. If created by `db diff -f`, local DB already has those changes
			// 2. If from external source (git pull), user should restart dev mode
			if watcher.MigrationsChanged() {
				fmt.Fprintln(os.Stderr, "[dev] Migration file changed - shadow template invalidated")
				InvalidateShadowTemplate()
				// Don't trigger schema diff - migrations need manual application
				// The next schema file change will use the updated shadow
				fmt.Fprintln(os.Stderr, "[dev] Note: Run 'supabase db reset' or restart dev mode to apply new migrations")
				fmt.Fprintln(os.Stderr, "[dev] Watching for changes...")
				continue
			}

			fmt.Fprintln(os.Stderr, "[dev] Applying schema changes...")
			if err := s.applySchemaChanges(); err != nil {
				fmt.Fprintf(os.Stderr, "[dev] %s %s\n", utils.Red("Error:"), err.Error())
			} else {
				fmt.Fprintln(os.Stderr, "[dev] Changes applied successfully")
			}
			fmt.Fprintln(os.Stderr, "[dev] Watching for changes...")
		case err := <-watcher.ErrCh:
			CleanupShadow(s.ctx)
			return errors.Errorf("watcher error: %w", err)
		}
	}
}

// validateConfig checks the configuration and warns about potential issues
func (s *Session) validateConfig() {
	schemasCfg := &utils.Config.Dev.Schemas
	seedCfg := &utils.Config.Dev.Seed

	// Warn if schema on_change command might not exist
	if schemasCfg.OnChange != "" {
		s.validateOnChangeCommand(schemasCfg.OnChange, "schemas")
	}

	// Warn if seed on_change command might not exist
	if seedCfg.OnChange != "" {
		s.validateOnChangeCommand(seedCfg.OnChange, "seed")
	}

	// Warn if types output directory doesn't exist
	if schemasCfg.Types != "" {
		dir := filepath.Dir(schemasCfg.Types)
		if dir != "." && dir != "" {
			if exists, _ := afero.DirExists(s.fsys, dir); !exists {
				fmt.Fprintf(os.Stderr, "[dev] %s types output directory '%s' does not exist\n", utils.Yellow("Warning:"), dir)
			}
		}
	}
}

// validateOnChangeCommand checks if the on_change command exists
func (s *Session) validateOnChangeCommand(command, configSection string) {
	cmdParts := strings.Fields(command)
	if len(cmdParts) > 0 {
		cmdName := cmdParts[0]
		// Check if it's a known package manager command
		if cmdName != "npx" && cmdName != "npm" && cmdName != "yarn" && cmdName != "pnpm" && cmdName != "bunx" {
			if _, err := exec.LookPath(cmdName); err != nil {
				fmt.Fprintf(os.Stderr, "[dev] %s %s on_change command '%s' not found in PATH\n", utils.Yellow("Warning:"), configSection, cmdName)
			}
		}
	}
}

// applySchemaChanges validates and applies schema changes to the local database
func (s *Session) applySchemaChanges() error {
	schemasConfig := &utils.Config.Dev.Schemas

	// Step 0: Verify DB is still running
	if err := utils.AssertSupabaseDbIsRunning(); err != nil {
		return errors.Errorf("local database stopped unexpectedly: %w", err)
	}

	// Check if we should use a custom on_change command
	if schemasConfig.OnChange != "" {
		return s.runCustomOnChange(schemasConfig.OnChange)
	}

	// Step 1: Load all schema files
	schemaFiles, err := loadSchemaFiles(s.fsys)
	if err != nil {
		return err
	}

	if len(schemaFiles) == 0 {
		fmt.Fprintln(os.Stderr, "No schema files found")
		return nil
	}

	// Step 2: Validate SQL syntax of all schema files
	if err := ValidateSchemaFiles(schemaFiles, s.fsys); err != nil {
		return err
	}

	// Step 3: Run diff and apply changes
	if err := s.diffAndApply(); err != nil {
		return err
	}

	// Step 4: Generate types if configured
	if schemasConfig.Types != "" {
		if err := s.generateTypes(schemasConfig.Types); err != nil {
			fmt.Fprintf(os.Stderr, "%s Failed to generate types: %s\n", utils.Yellow("Warning:"), err.Error())
		}
	}

	return nil
}

// runCustomOnChange executes a custom command when files change
func (s *Session) runCustomOnChange(command string) error {
	fmt.Fprintf(os.Stderr, "Running: %s\n", utils.Aqua(command))

	cmd := exec.CommandContext(s.ctx, "sh", "-c", command)
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	cmd.Dir = utils.CurrentDirAbs

	if err := cmd.Run(); err != nil {
		return errors.Errorf("on_change command failed: %w", err)
	}

	s.dirty = true

	// Generate types if configured (runs after custom command too)
	schemasConfig := &utils.Config.Dev.Schemas
	if schemasConfig.Types != "" {
		if err := s.generateTypes(schemasConfig.Types); err != nil {
			fmt.Fprintf(os.Stderr, "%s Failed to generate types: %s\n", utils.Yellow("Warning:"), err.Error())
		}
	}

	return nil
}

// generateTypes generates TypeScript types and writes them to the configured path
func (s *Session) generateTypes(outputPath string) error {
	fmt.Fprintf(os.Stderr, "Generating types to %s...\n", utils.Aqua(outputPath))

	// Run supabase gen types typescript --local
	cmd := exec.CommandContext(s.ctx, "supabase", "gen", "types", "typescript", "--local")
	output, err := cmd.Output()
	if err != nil {
		if exitErr, ok := err.(*exec.ExitError); ok {
			return errors.Errorf("type generation failed: %s", string(exitErr.Stderr))
		}
		return errors.Errorf("type generation failed: %w", err)
	}

	// Write output to file
	if err := afero.WriteFile(s.fsys, outputPath, output, 0644); err != nil {
		return errors.Errorf("failed to write types file: %w", err)
	}

	fmt.Fprintf(os.Stderr, "Types generated: %s\n", utils.Aqua(outputPath))
	return nil
}

// diffAndApply runs the schema diff and applies changes to local DB
func (s *Session) diffAndApply() error {
	applied, err := DiffAndApply(s.ctx, s.fsys, os.Stderr)
	if err != nil {
		return err
	}
	if applied {
		s.dirty = true
	}
	return nil
}

// showDirtyWarning warns if local DB has uncommitted schema changes
func (s *Session) showDirtyWarning() {
	if !s.dirty {
		return
	}
	fmt.Fprintf(os.Stderr, "%s Local database has uncommitted schema changes!\n", utils.Yellow("Warning:"))
	fmt.Fprintf(os.Stderr, "    Run '%s' to create a migration\n", utils.Aqua("supabase db diff -f migration_name"))
}

// loadSchemaFiles returns all .sql files in the schemas directory
func loadSchemaFiles(fsys afero.Fs) ([]string, error) {
	var files []string
	err := afero.Walk(fsys, utils.SchemasDir, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		if info.Mode().IsRegular() && len(path) > 4 && path[len(path)-4:] == ".sql" {
			files = append(files, path)
		}
		return nil
	})
	return files, err
}

