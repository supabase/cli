package serve

import (
	"context"
	"io"
	"log"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/fsnotify/fsnotify"
	"github.com/go-errors/errors"
	"github.com/spf13/afero"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/pkg/function"
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

// Global set to track directories already added for dependencies
var globalWatchedDirectories = make(map[string]bool)

// addImportDependenciesToWatcher finds TypeScript files in the functions directory,
// parses their import statements, and adds the directories containing imported files
// to the watcher. This ensures that changes to files outside the functions directory
// that are imported by functions will trigger reloads.
func addImportDependenciesToWatcher(watcher *fsnotify.Watcher, functionsPath string) error {

	// Walk through all TypeScript files in the functions directory
	err := filepath.Walk(functionsPath, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			log.Printf("Warning: error accessing path %s during walk: %v", path, err)
			return nil
		}

		// Only process TypeScript files
		if !info.IsDir() && (strings.HasSuffix(info.Name(), ".ts") || strings.HasSuffix(info.Name(), ".js")) {
			if err := addDependenciesForFile(watcher, path, functionsPath, globalWatchedDirectories); err != nil {
				log.Printf("Warning: error processing dependencies for %s: %v", path, err)
			}
		}
		return nil
	})

	return err
}

// addDependenciesForFile processes a single TypeScript/JavaScript file to find its imports
// and adds the directories of imported files to the watcher
func addDependenciesForFile(watcher *fsnotify.Watcher, filePath, functionsPath string, watchedDirectories map[string]bool) error {
	// Create a filesystem accessor
	fsys := afero.NewOsFs()

	// Create an ImportMap for parsing imports
	importMap := function.ImportMap{}

	// Check for import map in the same directory or parent directories
	dir := filepath.Dir(filePath)
	for {
		denoJsonPath := filepath.Join(dir, "deno.json")
		denoJsoncPath := filepath.Join(dir, "deno.jsonc")
		importMapPath := filepath.Join(dir, "import_map.json")

		if _, err := fsys.Stat(denoJsonPath); err == nil {
			if loadErr := importMap.LoadAsDeno(filepath.ToSlash(denoJsonPath), afero.NewIOFS(fsys)); loadErr != nil {
				log.Printf("Warning: failed to load deno.json at %s: %v", denoJsonPath, loadErr)
			}
			break
		} else if _, err := fsys.Stat(denoJsoncPath); err == nil {
			if loadErr := importMap.LoadAsDeno(filepath.ToSlash(denoJsoncPath), afero.NewIOFS(fsys)); loadErr != nil {
				log.Printf("Warning: failed to load deno.jsonc at %s: %v", denoJsoncPath, loadErr)
			}
			break
		} else if _, err := fsys.Stat(importMapPath); err == nil {
			if loadErr := importMap.Load(filepath.ToSlash(importMapPath), afero.NewIOFS(fsys)); loadErr != nil {
				log.Printf("Warning: failed to load import_map.json at %s: %v", importMapPath, loadErr)
			}
			break
		}

		parent := filepath.Dir(dir)
		if parent == dir {
			break // reached root
		}
		dir = parent
	}

	// Function to add a dependency file's directory to the watcher
	addDependency := func(depPath string, w io.Writer) error {
		// Convert to absolute path
		var absDepPath string
		if filepath.IsAbs(depPath) {
			absDepPath = depPath
		} else {
			absDepPath = filepath.Join(filepath.Dir(filePath), depPath)
		}
		absDepPath = filepath.Clean(absDepPath)

		// Get the directory containing the imported file
		depDir := filepath.Dir(absDepPath)

		// Only add directories that exist and aren't already watched
		if _, err := fsys.Stat(depDir); err == nil {
			if !watchedDirectories[depDir] {
				// Don't re-add directories that are already being watched by the main functions watcher
				if !strings.HasPrefix(depDir, functionsPath) {
					if err := watcher.Add(depDir); err != nil {
						log.Printf("Warning: could not watch dependency directory %s: %v", depDir, err)
					} else {
						log.Printf("Added dependency directory to watcher: %s", depDir)
						watchedDirectories[depDir] = true
					}
				}
			}
		}

		// Write the file content to the writer (required by WalkImportPaths interface)
		if f, err := fsys.Open(absDepPath); err == nil {
			defer f.Close()
			io.Copy(w, f)
		}

		return nil
	}

	// Walk through all imports starting from this file
	relFilePath := filepath.ToSlash(filePath)
	if err := importMap.WalkImportPaths(relFilePath, addDependency); err != nil {
		return errors.Errorf("failed to walk import paths for %s: %w", filePath, err)
	}

	return nil
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

	// Add directories containing imported dependencies
	if err := addImportDependenciesToWatcher(watcher, absFunctionsPath); err != nil {
		log.Printf("Warning: an error occurred while adding import dependencies to watcher: %v", err)
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
				} else if info != nil && !info.IsDir() {
					// Handle TypeScript/JavaScript file creation - rescan dependencies for this file
					if strings.HasSuffix(event.Name, ".ts") || strings.HasSuffix(event.Name, ".js") {
						if depErr := addDependenciesForFile(watcher, event.Name, watchedPath, globalWatchedDirectories); depErr != nil {
							log.Printf("Warning: error rescanning dependencies after file creation %s: %v", event.Name, depErr)
						}
					}
				}
			}

			// Handle TypeScript/JavaScript file modifications - rescan dependencies for this file
			if event.Has(fsnotify.Write) {
				if strings.HasSuffix(event.Name, ".ts") || strings.HasSuffix(event.Name, ".js") {
					if depErr := addDependenciesForFile(watcher, event.Name, watchedPath, globalWatchedDirectories); depErr != nil {
						log.Printf("Warning: error rescanning dependencies after file modification %s: %v", event.Name, depErr)
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
