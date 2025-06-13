package serve

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/fsnotify/fsnotify"
	"github.com/spf13/afero"
	"github.com/supabase/cli/internal/functions/deploy"
	"github.com/supabase/cli/internal/utils"
)

const (
	// Default debounce duration for edge function file changes
	DefaultEdgeFunctionDebounceDuration = 500 * time.Millisecond
)

var (
	// Directories to ignore for edge functions.
	edgeFunctionIgnoredDirNames = []string{
		".git",
		"node_modules",
		".vscode",
		".idea",
		".DS_Store",
		"vendor",
	}

	// Patterns for ignoring file events in edge functions.
	edgeFunctionIgnoredFilePatterns = []struct {
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

// EdgeFunctionWatcher provides file watching specifically for edge functions
type EdgeFunctionWatcher struct {
	genericWatcher *GenericFileWatcher
	fsys           afero.Fs
}

// NewEdgeFunctionWatcher creates a new edge function watcher
func NewEdgeFunctionWatcher(fsys afero.Fs) (*EdgeFunctionWatcher, error) {
	config := GenericFileWatcherConfig{
		DebounceDuration:     DefaultEdgeFunctionDebounceDuration,
		IgnoreFunc:           isIgnoredEdgeFunctionFileEvent,
		DirIgnoreFunc:        isIgnoredEdgeFunctionDir,
		SignificantEventFunc: isSignificantEdgeFunctionEvent,
	}

	genericWatcher, err := NewGenericFileWatcher(config)
	if err != nil {
		return nil, err
	}

	return &EdgeFunctionWatcher{
		genericWatcher: genericWatcher,
		fsys:           fsys,
	}, nil
}

// Watch starts watching for edge function file changes and returns channels for restart signals and errors
func (efw *EdgeFunctionWatcher) Watch(ctx context.Context) (<-chan struct{}, <-chan error) {
	// Calculate and set initial watch targets
	if err := efw.UpdateWatchTargets(); err != nil {
		// Return error channel with the error
		errorChan := make(chan error, 1)
		errorChan <- err
		return nil, errorChan
	}

	// Start watching
	restartChan, errorChan := efw.genericWatcher.Watch(ctx)

	// Create a new channel to handle refresh logic
	wrappedRestartChan := make(chan struct{})

	go func() {
		for {
			select {
			case <-ctx.Done():
				return
			case <-restartChan:
				// Refresh watch targets to catch any new dependencies
				if err := efw.UpdateWatchTargets(); err != nil {
					utils.Warning("could not update watch targets: %v", err)
				}
				wrappedRestartChan <- struct{}{}
			}
		}
	}()

	return wrappedRestartChan, errorChan
}

// Close closes the edge function watcher
func (efw *EdgeFunctionWatcher) Close() error {
	return efw.genericWatcher.Close()
}

// UpdateWatchTargets calculates which files and directories should be watched for edge functions
func (efw *EdgeFunctionWatcher) UpdateWatchTargets() error {
	var targets []WatchTarget

	// Always try to watch the functions directory if it exists
	functionsDir := utils.FunctionsDir
	absFunctionsPath := functionsDir

	if filepath.IsAbs(functionsDir) {
		absFunctionsPath = functionsDir
	} else {
		if utils.CurrentDirAbs != "" {
			absFunctionsPath = filepath.Join(utils.CurrentDirAbs, functionsDir)
		} else {
			cwd, err := os.Getwd()
			if err != nil {
				utils.Warning("could not get current working directory: %v", err)
			} else {
				absFunctionsPath = filepath.Join(cwd, functionsDir)
			}
		}
	}
	absFunctionsPath = filepath.Clean(absFunctionsPath)

	// Add functions directory if it exists - this will recursively watch subdirectories
	if _, err := os.Stat(absFunctionsPath); err == nil {
		targets = append(targets, WatchTarget{
			Path:   absFunctionsPath,
			IsFile: false,
		})
		utils.Info(1, "Added functions directory to watch targets: %s", absFunctionsPath)

		// Add all subdirectories within the functions directory for recursive watching
		err := filepath.Walk(absFunctionsPath, func(path string, info os.FileInfo, err error) error {
			if err != nil {
				return nil // Continue walking even if there's an error
			}

			if info.IsDir() && path != absFunctionsPath {
				// Check if this directory should be ignored
				if !isIgnoredEdgeFunctionDir(filepath.Base(path), absFunctionsPath, path) {
					targets = append(targets, WatchTarget{
						Path:   path,
						IsFile: false,
					})
					utils.Info(1, "Added subdirectory to watch targets: %s", path)
				}
			}
			return nil
		})
		if err != nil {
			utils.Warning("could not walk functions directory: %v", err)
		}
	}

	// Always try to watch the config.toml file if it exists
	configPath := utils.ConfigPath
	if !filepath.IsAbs(configPath) {
		if utils.CurrentDirAbs != "" {
			configPath = filepath.Join(utils.CurrentDirAbs, utils.ConfigPath)
		} else {
			cwd, err := os.Getwd()
			if err != nil {
				utils.Warning("could not get current working directory: %v", err)
			} else {
				configPath = filepath.Join(cwd, utils.ConfigPath)
			}
		}
	}
	configPath = filepath.Clean(configPath)

	// Add config file if it exists
	if _, err := os.Stat(configPath); err == nil {
		targets = append(targets, WatchTarget{
			Path:   configPath,
			IsFile: true,
		})
	}

	// Add import dependencies from function configurations
	slugs, err := deploy.GetFunctionSlugs(efw.fsys)
	if err != nil {
		utils.Warning("could not get function slugs: %v", err)
	} else {
		functionsConfig, err := deploy.GetFunctionConfig(slugs, "", nil, efw.fsys)
		if err != nil {
			utils.Warning("could not get function config: %v", err)
		} else {
			// Add directories from import dependencies
			dependencyDirs := make(map[string]bool)

			for _, fc := range functionsConfig {
				if !fc.Enabled {
					continue
				}

				modulePaths, err := utils.BindHostModules(utils.CurrentDirAbs, fc.Entrypoint, fc.ImportMap, efw.fsys)
				if err != nil {
					utils.Warning("could not get function paths: %v", err)
					continue
				}

				for _, path := range modulePaths.Paths {
					// Get the directory containing the path
					dir := filepath.Dir(path)
					dependencyDirs[dir] = true
				}
			}

			// Add unique dependency directories
			for dir := range dependencyDirs {
				// Only add if not already covered by functions directory or its subdirectories
				isAlreadyCovered := false
				if strings.HasPrefix(dir, absFunctionsPath) {
					isAlreadyCovered = true
				}

				if !isAlreadyCovered {
					targets = append(targets, WatchTarget{
						Path:   dir,
						IsFile: false,
					})
					utils.Info(1, "Added dependency directory to watch targets: %s", dir)
				}
			}
		}
	}

	// Set the watch targets
	return efw.genericWatcher.SetWatchTargets(targets)
}

// isIgnoredEdgeFunctionDir checks if a directory should be ignored by the edge function watcher
func isIgnoredEdgeFunctionDir(dirName string, rootWatchedPath string, currentPath string) bool {
	// Never ignore the root watched directory itself, even if it's a dot-directory
	if filepath.Clean(currentPath) == filepath.Clean(rootWatchedPath) {
		return false
	}

	for _, ignoredName := range edgeFunctionIgnoredDirNames {
		if dirName == ignoredName {
			return true
		}
	}

	// By default, ignore all directories starting with a "." (dot-directories)
	// unless it's the root path (already handled) or "." and ".." which are not actual directory names from Walk
	if strings.HasPrefix(dirName, ".") && dirName != "." && dirName != ".." {
		return true
	}

	return false
}

// isIgnoredEdgeFunctionFileEvent checks if a file event should be ignored based on edge function patterns
func isIgnoredEdgeFunctionFileEvent(eventName string, eventOp fsnotify.Op) bool {
	baseName := filepath.Base(eventName)
	for _, p := range edgeFunctionIgnoredFilePatterns {
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

// isSignificantEdgeFunctionEvent determines if an event should trigger a restart for edge functions
func isSignificantEdgeFunctionEvent(event fsnotify.Event) bool {
	return event.Has(fsnotify.Write) || event.Has(fsnotify.Create) || event.Has(fsnotify.Remove) || event.Has(fsnotify.Rename)
}
