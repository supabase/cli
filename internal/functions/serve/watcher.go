package serve

import (
	"context"
	"log"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/fsnotify/fsnotify"
	"github.com/go-errors/errors"
	"github.com/supabase/cli/internal/utils"
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

// addDirectoriesToWatcher recursively walks a directory tree and adds non-ignored
// directories to the watcher. It handles errors gracefully and continues walking
// even if some directories cannot be watched.
func addDirectoriesToWatcher(watcher *fsnotify.Watcher, rootPath, watchedPath string) error {
	return filepath.Walk(rootPath, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			log.Printf("Warning: error accessing path %s during walk: %v", path, err)
			return nil
		}

		if info.IsDir() {
			if isIgnoredDir(info.Name(), watchedPath, path) {
				return filepath.SkipDir
			}

			if err := watcher.Add(path); err != nil {
				log.Printf("Warning: could not watch directory %s: %v", path, err)
			}
		}
		return nil
	})
}

// setupFileWatcher initializes a new fsnotify.Watcher and adds the functions directory
// and its subdirectories to it.
func setupFileWatcher() (*fsnotify.Watcher, string, error) {
	watcher, err := fsnotify.NewWatcher()
	if err != nil {
		return nil, "", errors.Errorf("failed to create file watcher: %w", err)
	}

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
				log.Printf("Warning: could not get current working directory: %v. Using relative path for watcher: %s", CWDerr, functionsDir)
			} else {
				absFunctionsPath = filepath.Join(cwd, functionsDir)
			}
		}
	}
	absFunctionsPath = filepath.Clean(absFunctionsPath)

	err = watcher.Add(absFunctionsPath)
	if err != nil {
		log.Printf("Warning: could not watch functions directory %s - hot-reloading will be unavailable. Error: %v", absFunctionsPath, err)
		// Return the watcher but an empty path to signal that watching isn't properly set up.
		return watcher, "", nil
	}

	// Recursively add subdirectories
	if err := addDirectoriesToWatcher(watcher, absFunctionsPath, absFunctionsPath); err != nil {
		log.Printf("Warning: an error occurred during directory walk for watcher setup on %s: %v", absFunctionsPath, err)
	}

	return watcher, absFunctionsPath, nil
}

// runFileWatcher listens for events from the watcher, debounces them, and signals for a restart.
func runFileWatcher(ctx context.Context, watcher *fsnotify.Watcher, watchedPath string, restartChan chan<- struct{}) {
	var restartTimer *time.Timer // Timer for debouncing restarts
	const debounceDuration = 500 * time.Millisecond

	if watchedPath == "" {
		return
	}

	for {
		select {
		case event, ok := <-watcher.Events:
			if !ok {
				return
			}

			if !strings.HasPrefix(event.Name, watchedPath) && event.Name != watchedPath {
				continue
			}

			if isIgnoredFileEvent(event.Name, event.Op) {
				continue
			}

			// Handle directory creation immediately for watcher updates
			if event.Has(fsnotify.Create) {
				if info, err := os.Stat(event.Name); err == nil && info.IsDir() {
					newDirPath := event.Name
					if !isIgnoredDir(info.Name(), watchedPath, newDirPath) {
						if errAdd := watcher.Add(newDirPath); errAdd != nil {
							log.Printf("Warning: could not add new directory %s to watcher: %v", newDirPath, errAdd)
						} else {
							// Recursively add subdirectories of the new directory
							if walkErr := addDirectoriesToWatcher(watcher, newDirPath, watchedPath); walkErr != nil {
								log.Printf("Warning: error walking new directory %s: %v", newDirPath, walkErr)
							}
						}
					}
				}
			}

			// Handle file change events that should trigger a restart
			isSignificantEventForRestart := event.Has(fsnotify.Write) || event.Has(fsnotify.Create) || event.Has(fsnotify.Remove) || event.Has(fsnotify.Rename)

			if isSignificantEventForRestart {
				log.Printf("File change detected: %s (%s)", event.Name, event.Op.String())
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
			log.Printf("File watcher error: %v", err)
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
	SetupFileWatcher() (*fsnotify.Watcher, string, error)
}

// RealFileWatcherSetup implements FileWatcherSetup using the real filesystem
type RealFileWatcherSetup struct{}

func (r *RealFileWatcherSetup) SetupFileWatcher() (*fsnotify.Watcher, string, error) {
	return setupFileWatcher()
}

// MockFileWatcherSetup implements FileWatcherSetup for testing
type MockFileWatcherSetup struct {
	MockWatcher *fsnotify.Watcher
	MockPath    string
	MockError   error
}

func (m *MockFileWatcherSetup) SetupFileWatcher() (*fsnotify.Watcher, string, error) {
	return m.MockWatcher, m.MockPath, m.MockError
}
