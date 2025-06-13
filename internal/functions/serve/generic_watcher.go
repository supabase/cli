package serve

import (
	"context"
	"path/filepath"
	"strings"
	"time"

	"github.com/fsnotify/fsnotify"
	"github.com/go-errors/errors"
	"github.com/supabase/cli/internal/utils"
)

// WatchTarget represents a file or directory to watch
type WatchTarget struct {
	Path   string
	IsFile bool // true for files, false for directories
}

// IgnoreFunc is a function type for determining if a file event should be ignored
type IgnoreFunc func(eventPath string, eventOp fsnotify.Op) bool

// DirIgnoreFunc is a function type for determining if a directory should be ignored
type DirIgnoreFunc func(dirName string, rootWatchedPath string, currentPath string) bool

// SignificantEventFunc is a function type for determining if an event should trigger a restart
type SignificantEventFunc func(event fsnotify.Event) bool

// GenericFileWatcher provides a configurable file system watcher
type GenericFileWatcher struct {
	watcher              *fsnotify.Watcher
	watchTargets         []WatchTarget
	watchedPaths         map[string]bool
	debounceDuration     time.Duration
	ignoreFunc           IgnoreFunc
	dirIgnoreFunc        DirIgnoreFunc
	significantEventFunc SignificantEventFunc
	restartChan          chan struct{}
	errorChan            chan error
}

// GenericFileWatcherConfig holds configuration for the generic file watcher
type GenericFileWatcherConfig struct {
	DebounceDuration     time.Duration
	IgnoreFunc           IgnoreFunc
	DirIgnoreFunc        DirIgnoreFunc
	SignificantEventFunc SignificantEventFunc
}

// NewGenericFileWatcher creates a new generic file watcher with the given configuration
func NewGenericFileWatcher(config GenericFileWatcherConfig) (*GenericFileWatcher, error) {
	watcher, err := fsnotify.NewWatcher()
	if err != nil {
		return nil, errors.Errorf("failed to create file watcher: %w", err)
	}

	return &GenericFileWatcher{
		watcher:              watcher,
		watchedPaths:         make(map[string]bool),
		debounceDuration:     config.DebounceDuration,
		ignoreFunc:           config.IgnoreFunc,
		dirIgnoreFunc:        config.DirIgnoreFunc,
		significantEventFunc: config.SignificantEventFunc,
		restartChan:          make(chan struct{}),
		errorChan:            make(chan error),
	}, nil
}

// SetWatchTargets sets the files and directories to watch
func (gfw *GenericFileWatcher) SetWatchTargets(targets []WatchTarget) error {
	// Remove existing watches
	for path := range gfw.watchedPaths {
		if err := gfw.watcher.Remove(path); err != nil {
			utils.Warning("could not remove path from watcher %s: %v", path, err)
		}
	}
	gfw.watchedPaths = make(map[string]bool)
	gfw.watchTargets = targets

	// Add new watches
	for _, target := range targets {
		if target.IsFile {
			// For files, watch the file itself directly
			if !gfw.watchedPaths[target.Path] {
				if err := gfw.watcher.Add(target.Path); err != nil {
					utils.Warning("could not watch file %s: %v", target.Path, err)
				} else {
					utils.Info(1, "Added file to watcher: %s", target.Path)
					gfw.watchedPaths[target.Path] = true
				}
			}
		} else {
			// For directories, watch the directory itself
			if !gfw.watchedPaths[target.Path] {
				if err := gfw.watcher.Add(target.Path); err != nil {
					utils.Warning("could not watch directory %s: %v", target.Path, err)
				} else {
					utils.Info(1, "Added directory to watcher: %s", target.Path)
					gfw.watchedPaths[target.Path] = true
				}
			}
		}
	}

	return nil
}

// Watch starts watching for file system events and returns channels for restart signals and errors
func (gfw *GenericFileWatcher) Watch(ctx context.Context) (<-chan struct{}, <-chan error) {
	go gfw.runWatcher(ctx)
	return gfw.restartChan, gfw.errorChan
}

// runWatcher listens for events from the watcher, debounces them, and signals for a restart
func (gfw *GenericFileWatcher) runWatcher(ctx context.Context) {
	var restartTimer *time.Timer // Timer for debouncing restarts

	for {
		select {
		case event, ok := <-gfw.watcher.Events:
			if !ok {
				return
			}

			// Check if this event should be ignored
			if gfw.ignoreFunc != nil && gfw.ignoreFunc(event.Name, event.Op) {
				utils.Debug("Ignoring file event: %s (%s)", event.Name, event.Op.String())
				continue
			}

			// Check if this is a path we're watching
			shouldProcess := false
			eventPath := filepath.Clean(event.Name)

			// Check if this event is for a target we're watching
			for _, target := range gfw.watchTargets {
				targetPath := filepath.Clean(target.Path)

				if target.IsFile {
					// For file targets, event must be for the exact file
					if eventPath == targetPath {
						shouldProcess = true
						break
					}
				} else {
					// For directory targets, check if the event is within this directory
					if eventPath == targetPath || strings.HasPrefix(eventPath, targetPath+string(filepath.Separator)) {
						shouldProcess = true
						break
					}
				}
			}

			if !shouldProcess {
				continue
			}

			// Handle file change events that should trigger a restart
			var isSignificantEventForRestart bool
			if gfw.significantEventFunc != nil {
				isSignificantEventForRestart = gfw.significantEventFunc(event)
			} else {
				// Default behavior if no function provided
				isSignificantEventForRestart = event.Has(fsnotify.Write) || event.Has(fsnotify.Create) || event.Has(fsnotify.Remove) || event.Has(fsnotify.Rename)
			}

			if isSignificantEventForRestart {
				utils.Info(2, "File change detected: %s (%s)", event.Name, event.Op.String())

				if restartTimer != nil {
					restartTimer.Stop()
				}
				restartTimer = time.AfterFunc(gfw.debounceDuration, func() {
					select {
					case gfw.restartChan <- struct{}{}:
					case <-ctx.Done():
					}
				})
			}

		case err, ok := <-gfw.watcher.Errors:
			if !ok {
				return
			}
			select {
			case gfw.errorChan <- err:
			case <-ctx.Done():
			}

		case <-ctx.Done():
			if restartTimer != nil {
				restartTimer.Stop()
			}
			return
		}
	}
}

// Close closes the file watcher
func (gfw *GenericFileWatcher) Close() error {
	if gfw.watcher != nil {
		return gfw.watcher.Close()
	}
	return nil
}
