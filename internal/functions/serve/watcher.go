package serve

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/fsnotify/fsnotify"
	"github.com/go-errors/errors"
	"github.com/spf13/afero"
	"github.com/supabase/cli/internal/functions/deploy"
	"github.com/supabase/cli/internal/utils"
)

const (
	// Debounce duration for file changes
	debounceDuration = 500 * time.Millisecond
)

var (
	// Directories to ignore.
	ignoredDirNames = []string{
		".git",
		"node_modules",
		".vscode",
		".idea",
		".DS_Store",
		"vendor",
	}

	// Patterns for ignoring file events.
	ignoredFilePatterns = []struct {
		Prefix     string      // File basename prefix
		Suffix     string      // File basename suffix
		ExactMatch string      // File basename exact match
		Op         fsnotify.Op // Specific operation to ignore for this pattern (0 for any op)
	}{
		{Suffix: "~"},                       // Common backup files (e.g., emacs, gedit)
		{Prefix: ".", Suffix: ".swp"},       // Vim swap files
		{Prefix: ".", Suffix: ".swx"},       // Vim swap files (extended)
		{Prefix: "___", Suffix: "___"},      // Deno deploy/bundle temporary files often look like ___<slug>___<hash>___
		{Prefix: "___"},                     // Some other editor temp files might start with this
		{Suffix: ".tmp"},                    // Generic temp files
		{Prefix: ".#"},                      // Emacs lock files
		{Suffix: "___", Op: fsnotify.Chmod}, // Deno specific temp file pattern during write (often involves a chmod)
	}
)

// isIgnoredDir checks if a directory should be ignored by the watcher.
// rootWatchedPath is the main directory being watched (e.g., "supabase/functions").
// currentPath is the path of the directory being considered.
func isIgnoredDir(dirName string, rootWatchedPath string, currentPath string) bool {
	// Never ignore the root watched directory itself, even if it's a dot-directory.
	if filepath.Clean(currentPath) == filepath.Clean(rootWatchedPath) {
		return false
	}

	for _, ignoredName := range ignoredDirNames {
		if dirName == ignoredName {
			return true
		}
	}
	// By default, ignore all directories starting with a "." (dot-directories)
	// unless it's the root path (already handled) or "." and ".." which are not actual directory names from Walk.
	if strings.HasPrefix(dirName, ".") && dirName != "." && dirName != ".." {
		return true
	}
	return false
}

// isIgnoredFileEvent checks if a file event should be ignored based on predefined patterns.
func isIgnoredFileEvent(eventName string, eventOp fsnotify.Op) bool {
	baseName := filepath.Base(eventName)
	for _, p := range ignoredFilePatterns {
		match := false
		if p.ExactMatch != "" && baseName == p.ExactMatch {
			match = true
		} else {
			// Check prefix if specified
			prefixMatch := p.Prefix == "" || strings.HasPrefix(baseName, p.Prefix)
			// Check suffix if specified
			suffixMatch := p.Suffix == "" || strings.HasSuffix(baseName, p.Suffix)

			// Both prefix and suffix must match
			if p.Prefix != "" && p.Suffix != "" {
				match = prefixMatch && suffixMatch
				// Only prefix specified
			} else if p.Prefix != "" {
				match = prefixMatch
				// Only suffix specified
			} else if p.Suffix != "" {
				match = suffixMatch
			}
		}

		if match {
			// If Op is 0, it means the pattern applies to any operation.
			// Otherwise, check if the event's operation is relevant to the pattern's Op.
			if p.Op == 0 || (eventOp&p.Op) != 0 {
				return true
			}
		}
	}
	return false
}

// addImportDependenciesToWatcher adds all import dependencies to the watcher
// and removes directories that are no longer needed
func addImportDependenciesToWatcher(watcher *fsnotify.Watcher, watchedDirs map[string]bool, fsys afero.Fs) error {
	slugs, err := deploy.GetFunctionSlugs(fsys)
	if err != nil {
		return err
	}

	functionsConfig, err := deploy.GetFunctionConfig(slugs, "", nil, fsys)
	if err != nil {
		return err
	}

	// Calculate which directories should be watched
	shouldWatchDirs := make(map[string]bool)

	// Always watch the functions directory itself if it exists
	functionsDir := utils.FunctionsDir
	absFunctionsPath := functionsDir
	if filepath.IsAbs(functionsDir) {
		absFunctionsPath = functionsDir
	} else {
		if utils.CurrentDirAbs != "" {
			absFunctionsPath = filepath.Join(utils.CurrentDirAbs, functionsDir)
		} else {
			cwd, CWDerr := os.Getwd()
			if CWDerr != nil {
				utils.Warning("could not get current working directory: %v", CWDerr)
			} else {
				absFunctionsPath = filepath.Join(cwd, functionsDir)
			}
		}
	}
	absFunctionsPath = filepath.Clean(absFunctionsPath)

	// Only add functions directory if it exists
	if _, err := os.Stat(absFunctionsPath); err == nil {
		shouldWatchDirs[absFunctionsPath] = true
	}

	for _, fc := range functionsConfig {
		if !fc.Enabled {
			continue
		}

		modulePaths, err := utils.BindHostModules(utils.CurrentDirAbs, fc.Entrypoint, fc.ImportMap, fsys)
		if err != nil {
			utils.Warning("could not get function paths: %v", err)
			continue
		}

		for _, path := range modulePaths.Paths {
			// Get the directory containing the path
			dir := filepath.Dir(path)
			shouldWatchDirs[dir] = true
		}
	}

	// Remove directories that are no longer needed
	for watchedDir := range watchedDirs {
		if !shouldWatchDirs[watchedDir] {
			if err := watcher.Remove(watchedDir); err != nil {
				utils.Warning("could not remove directory from watcher %s: %v", watchedDir, err)
			} else {
				utils.Info(1, "Removed directory from watcher: %s", watchedDir)
				delete(watchedDirs, watchedDir)
			}
		}
	}

	// Add new directories that should be watched but aren't yet
	for dir := range shouldWatchDirs {
		if !watchedDirs[dir] {
			if err := watcher.Add(dir); err != nil {
				utils.Warning("could not watch directory %s: %v", dir, err)
			} else {
				utils.Info(1, "Added directory to watcher: %s", dir)
				watchedDirs[dir] = true
			}
		}
	}

	return nil
}

// setupFileWatcher initializes a new fsnotify.Watcher and adds the functions directory
// and its subdirectories to it.
func setupFileWatcher(fsys afero.Fs) (*fsnotify.Watcher, string, error) {
	watcher, err := fsnotify.NewWatcher()
	if err != nil {
		return nil, "", errors.Errorf("failed to create file watcher: %w", err)
	}

	// Track which directories we've already added to the watcher
	watchedDirs := make(map[string]bool)

	// e.g., "supabase/functions"
	functionsDir := utils.FunctionsDir
	// Default to relative path if absolute conversion fails
	absFunctionsPath := functionsDir

	if filepath.IsAbs(functionsDir) {
		absFunctionsPath = functionsDir
	} else {
		if utils.CurrentDirAbs != "" {
			absFunctionsPath = filepath.Join(utils.CurrentDirAbs, functionsDir)
		} else {
			// Fallback to current working directory
			cwd, CWDerr := os.Getwd()
			if CWDerr != nil {
				utils.Warning("could not get current working directory: %v. Using relative path for watcher: %s", CWDerr, functionsDir)
			} else {
				absFunctionsPath = filepath.Join(cwd, functionsDir)
			}
		}
	}
	absFunctionsPath = filepath.Clean(absFunctionsPath)

	// Add all import dependencies to the watcher (including the functions directory itself)
	if err := addImportDependenciesToWatcher(watcher, watchedDirs, fsys); err != nil {
		utils.Warning("could not add import dependencies to watcher: %v", err)
		// Return the watcher but an empty path to signal that watching isn't properly set up.
		return watcher, "", nil
	}

	// If no directories are being watched (e.g., functions directory doesn't exist), return empty path
	if len(watchedDirs) == 0 {
		utils.Info(1, "No directories found to watch")
		return watcher, "", nil
	}

	utils.Info(1, "File watcher initialized, watching %d directories", len(watchedDirs))
	return watcher, absFunctionsPath, nil
}

// runFileWatcher listens for events from the watcher, debounces them, and signals for a restart.
func runFileWatcher(ctx context.Context, watcher *fsnotify.Watcher, watchedPath string, restartChan chan<- struct{}, watchedDirs map[string]bool, fsys afero.Fs) {
	var restartTimer *time.Timer // Timer for debouncing restarts

	if watchedPath == "" {
		return
	}

	for {
		select {
		case event, ok := <-watcher.Events:
			if !ok {
				return
			}

			if isIgnoredFileEvent(event.Name, event.Op) {
				utils.Debug("Ignoring file event: %s (%s)", event.Name, event.Op.String())
				continue
			}

			// Handle file change events that should trigger a restart
			isSignificantEventForRestart := event.Has(fsnotify.Write) || event.Has(fsnotify.Create) || event.Has(fsnotify.Remove) || event.Has(fsnotify.Rename)

			if isSignificantEventForRestart {
				utils.Info(2, "File change detected: %s (%s)", event.Name, event.Op.String())

				// Re-add import dependencies to catch any new dependencies
				if err := addImportDependenciesToWatcher(watcher, watchedDirs, fsys); err != nil {
					utils.Warning("could not update import dependencies: %v", err)
				}

				if restartTimer != nil {
					restartTimer.Stop()
				}
				restartTimer = time.AfterFunc(debounceDuration, func() {
					restartChan <- struct{}{}
				})
			}

		case err, ok := <-watcher.Errors:
			if !ok {
				return
			}
			utils.Warning("File watcher error: %v", err)
		case <-ctx.Done():
			if restartTimer != nil {
				restartTimer.Stop()
			}
			return
		}
	}
}

// FileWatcherSetup interface allows for dependency injection of file watching functionality
type FileWatcherSetup interface {
	SetupFileWatcher(fsys afero.Fs) (*fsnotify.Watcher, string, error)
}

type RealFileWatcherSetup struct{}

func (r *RealFileWatcherSetup) SetupFileWatcher(fsys afero.Fs) (*fsnotify.Watcher, string, error) {
	return setupFileWatcher(fsys)
}

type MockFileWatcherSetup struct {
	MockWatcher *fsnotify.Watcher
	MockPath    string
	MockError   error
}

func (m *MockFileWatcherSetup) SetupFileWatcher(fsys afero.Fs) (*fsnotify.Watcher, string, error) {
	return m.MockWatcher, m.MockPath, m.MockError
}
