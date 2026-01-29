package dev

import (
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"time"

	"github.com/bmatcuk/doublestar/v4"
	"github.com/fsnotify/fsnotify"
	"github.com/go-errors/errors"
	"github.com/spf13/afero"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/pkg/config"
)

const (
	// Default debounce duration for file changes
	defaultDebounceDuration = 500 * time.Millisecond
	restartEvents           = fsnotify.Write | fsnotify.Create | fsnotify.Remove | fsnotify.Rename

	// Internal glob pattern for migrations (always watched)
	migrationsGlob = "migrations/*.sql"
)

var (
	// Directories to ignore
	ignoredDirNames = []string{
		".git",
		"node_modules",
		".vscode",
		".idea",
		".DS_Store",
	}

	// Patterns for ignoring file events
	ignoredFilePatterns = []struct {
		Prefix string
		Suffix string
	}{
		{Suffix: "~"},                 // Common backup files
		{Prefix: ".", Suffix: ".swp"}, // Vim swap files
		{Prefix: ".", Suffix: ".swx"}, // Vim swap files (extended)
		{Suffix: ".tmp"},              // Generic temp files
		{Prefix: ".#"},                // Emacs lock files
	}
)

// SchemaWatcher watches for file changes based on configured glob patterns
type SchemaWatcher struct {
	fsys              afero.Fs
	watcher           *fsnotify.Watcher
	restartTimer      *time.Timer
	RestartCh         <-chan time.Time
	ErrCh             <-chan error
	watchGlobs        config.Glob // Glob patterns to match schema files
	seedGlobs         config.Glob // Glob patterns to match seed files
	migrationsChanged bool        // Track if migrations changed since last check
	seedsChanged      bool        // Track if seeds changed since last check
}

// NewSchemaWatcher creates a new watcher for the configured watch patterns
func NewSchemaWatcher(fsys afero.Fs, watchGlobs, seedGlobs config.Glob) (*SchemaWatcher, error) {
	restartTimer := time.NewTimer(defaultDebounceDuration)
	if !restartTimer.Stop() {
		return nil, errors.New("failed to initialise timer")
	}

	watcher, err := fsnotify.NewWatcher()
	if err != nil {
		return nil, errors.Errorf("failed to create file watcher: %w", err)
	}

	sw := &SchemaWatcher{
		fsys:         fsys,
		watcher:      watcher,
		restartTimer: restartTimer,
		RestartCh:    restartTimer.C,
		ErrCh:        watcher.Errors,
		watchGlobs:   watchGlobs,
		seedGlobs:    seedGlobs,
	}

	// Add directories containing watched files
	if err := sw.addWatchPaths(fsys); err != nil {
		watcher.Close()
		return nil, err
	}

	return sw, nil
}

// addWatchPaths adds directories that may contain watched files
func (w *SchemaWatcher) addWatchPaths(fsys afero.Fs) error {
	// Extract base directories from glob patterns
	dirs := make(map[string]struct{})
	for _, pattern := range w.watchGlobs {
		// Get the base directory before any glob characters
		baseDir := getGlobBaseDir(pattern)
		if baseDir == "" {
			baseDir = "."
		}
		// Make relative to supabase dir
		fullPath := filepath.Join(utils.SupabaseDirPath, baseDir)
		dirs[fullPath] = struct{}{}
	}

	// Add seed directories (seed globs are already absolute paths from config resolution)
	for _, pattern := range w.seedGlobs {
		baseDir := getGlobBaseDir(pattern)
		if baseDir == "" {
			baseDir = "."
		}
		dirs[baseDir] = struct{}{}
	}

	// Always watch migrations directory (internal, not user-configurable)
	dirs[utils.MigrationsDir] = struct{}{}

	// Add each unique directory and its subdirectories
	for dir := range dirs {
		if err := w.watchDirRecursive(fsys, dir); err != nil {
			// Skip if directory doesn't exist (will be created later)
			if errors.Is(err, os.ErrNotExist) {
				watcherLog.Printf("Watch directory does not exist (yet): %s", dir)
				continue
			}
			return err
		}
	}

	return nil
}

// watchDirRecursive adds a directory and all subdirectories to the watcher
func (w *SchemaWatcher) watchDirRecursive(fsys afero.Fs, rootDir string) error {
	return afero.Walk(fsys, rootDir, func(path string, info fs.FileInfo, err error) error {
		if err != nil {
			return err
		}

		// Skip ignored directories
		if info.IsDir() {
			if slices.Contains(ignoredDirNames, filepath.Base(path)) {
				return filepath.SkipDir
			}
			if err := w.watcher.Add(path); err != nil {
				return errors.Errorf("failed to watch directory %s: %w", path, err)
			}
			watcherLog.Printf("Watching directory: %s", path)
		}

		return nil
	})
}

// getGlobBaseDir extracts the base directory from a glob pattern
// e.g., "schemas/**/*.sql" -> "schemas"
// e.g., "src/db/schema/**/*.ts" -> "src/db/schema"
func getGlobBaseDir(pattern string) string {
	// Find first glob metacharacter
	for i, c := range pattern {
		if c == '*' || c == '?' || c == '[' || c == '{' {
			// Return directory up to this point
			dir := filepath.Dir(pattern[:i])
			if dir == "." && i > 0 {
				// Handle case like "schemas/**" where we want "schemas"
				if idx := strings.LastIndex(pattern[:i], string(filepath.Separator)); idx >= 0 {
					return pattern[:idx]
				}
				return pattern[:i]
			}
			return dir
		}
	}
	// No glob characters, return the directory part
	return filepath.Dir(pattern)
}

// Start begins watching for file changes
func (w *SchemaWatcher) Start() {
	for {
		event, ok := <-w.watcher.Events
		if !ok {
			return
		}

		// Handle new directory creation - add it to the watcher
		if event.Has(fsnotify.Create) {
			if info, err := os.Stat(event.Name); err == nil && info.IsDir() {
				if !slices.Contains(ignoredDirNames, filepath.Base(event.Name)) {
					if err := w.watcher.Add(event.Name); err == nil {
						watcherLog.Printf("Added new directory to watch: %s", event.Name)
					}
				}
				continue
			}
		}

		if isIgnoredFileEvent(event) {
			watcherLog.Printf("Ignoring file event: %s (%s)", event.Name, event.Op.String())
			continue
		}

		// Check if the file matches any of our watch globs
		if !w.matchesWatchGlobs(event.Name) {
			watcherLog.Printf("File does not match watch patterns: %s", event.Name)
			continue
		}

		// Skip empty files (e.g., newly created files with no content yet)
		if w.isEmptyFile(event.Name) {
			watcherLog.Printf("Skipping empty file: %s", event.Name)
			continue
		}

		// Track the type of file change
		if w.isMigrationFile(event.Name) {
			w.migrationsChanged = true
			fmt.Fprintf(os.Stderr, "[dev] Migration change detected: %s\n", event.Name)
		} else if w.isSeedFile(event.Name) {
			w.seedsChanged = true
			fmt.Fprintf(os.Stderr, "[dev] Seed file change detected: %s\n", event.Name)
		} else {
			fmt.Fprintf(os.Stderr, "[dev] Schema change detected: %s\n", event.Name)
		}

		// Fire immediately when timer is inactive, without blocking this thread
		if active := w.restartTimer.Reset(0); active {
			w.restartTimer.Reset(defaultDebounceDuration)
		}
	}
}

// matchesWatchGlobs checks if a file path matches any of the configured glob patterns
// or the internal migrations pattern
func (w *SchemaWatcher) matchesWatchGlobs(filePath string) bool {
	// Convert to relative path from supabase directory for matching
	relPath, err := filepath.Rel(utils.SupabaseDirPath, filePath)
	if err != nil {
		relPath = filePath
	}

	// Check schema patterns
	for _, pattern := range w.watchGlobs {
		matched, err := doublestar.Match(pattern, relPath)
		if err != nil {
			watcherLog.Printf("Invalid glob pattern %s: %v", pattern, err)
			continue
		}
		if matched {
			return true
		}
	}

	// Check seed patterns (seed globs are already absolute paths from config resolution)
	for _, pattern := range w.seedGlobs {
		matched, err := doublestar.Match(pattern, filePath)
		if err != nil {
			watcherLog.Printf("Invalid glob pattern %s: %v", pattern, err)
			continue
		}
		if matched {
			return true
		}
	}

	// Check migrations pattern (always watched internally)
	if matched, _ := doublestar.Match(migrationsGlob, relPath); matched {
		return true
	}

	return false
}

// isMigrationFile checks if a file path is a migration file
func (w *SchemaWatcher) isMigrationFile(filePath string) bool {
	relPath, err := filepath.Rel(utils.SupabaseDirPath, filePath)
	if err != nil {
		relPath = filePath
	}
	matched, _ := doublestar.Match(migrationsGlob, relPath)
	return matched
}

// MigrationsChanged returns true if migrations changed since last check and resets the flag
func (w *SchemaWatcher) MigrationsChanged() bool {
	changed := w.migrationsChanged
	w.migrationsChanged = false
	return changed
}

// isSeedFile checks if a file path matches seed patterns
func (w *SchemaWatcher) isSeedFile(filePath string) bool {
	for _, pattern := range w.seedGlobs {
		matched, _ := doublestar.Match(pattern, filePath)
		if matched {
			return true
		}
	}
	return false
}

// SeedsChanged returns true if seeds changed since last check and resets the flag
func (w *SchemaWatcher) SeedsChanged() bool {
	changed := w.seedsChanged
	w.seedsChanged = false
	return changed
}

// Close stops the watcher and releases resources
func (w *SchemaWatcher) Close() error {
	return w.watcher.Close()
}

// isEmptyFile checks if a file has no content (or only whitespace)
func (w *SchemaWatcher) isEmptyFile(path string) bool {
	content, err := afero.ReadFile(w.fsys, path)
	if err != nil {
		// File might have been deleted, let the event through
		return false
	}
	return len(strings.TrimSpace(string(content))) == 0
}

// isIgnoredFileEvent checks if a file event should be ignored
func isIgnoredFileEvent(event fsnotify.Event) bool {
	if !event.Has(restartEvents) {
		return true
	}

	baseName := filepath.Base(event.Name)
	for _, p := range ignoredFilePatterns {
		if strings.HasPrefix(baseName, p.Prefix) && strings.HasSuffix(baseName, p.Suffix) {
			return true
		}
	}

	return false
}
