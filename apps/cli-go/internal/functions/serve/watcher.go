package serve

import (
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"time"

	"github.com/fsnotify/fsnotify"
	"github.com/go-errors/errors"
	"github.com/spf13/afero"
	"github.com/spf13/viper"
	"github.com/supabase/cli/internal/utils"
)

const (
	// Debounce duration for file changes
	debounceDuration = 500 * time.Millisecond
	restartEvents    = fsnotify.Write | fsnotify.Create | fsnotify.Remove | fsnotify.Rename
	maxFileLimit     = 1000
)

var (
	errTooManyFiles = errors.New("too many files")

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
		Prefix     string // File basename prefix
		Suffix     string // File basename suffix
		ExactMatch bool   // File basename exact match
	}{
		{Suffix: "~"},                 // Common backup files (e.g., emacs, gedit)
		{Prefix: ".", Suffix: ".swp"}, // Vim swap files
		{Prefix: ".", Suffix: ".swx"}, // Vim swap files (extended)
		{Prefix: "___"},               // Deno temp files often start with this
		{Suffix: ".tmp"},              // Generic temp files
		{Prefix: ".#"},                // Emacs lock files
	}
)

// isIgnoredFileEvent checks if a file event should be ignored based on predefined patterns.
func isIgnoredFileEvent(event fsnotify.Event) bool {
	if !event.Has(restartEvents) {
		return true
	}
	baseName := filepath.Base(event.Name)
	for _, p := range ignoredFilePatterns {
		if strings.HasPrefix(baseName, p.Prefix) && strings.HasSuffix(baseName, p.Suffix) {
			// An exact match means all characters match both prefix and suffix
			if p.ExactMatch && len(baseName) > len(p.Prefix)+len(p.Suffix) {
				continue
			}
			return true
		}
	}
	return false
}

type debounceFileWatcher struct {
	watcher      *fsnotify.Watcher
	restartTimer *time.Timer
	RestartCh    <-chan time.Time
	ErrCh        <-chan error
}

func NewDebounceFileWatcher() (*debounceFileWatcher, error) {
	restartTimer := time.NewTimer(debounceDuration)
	if !restartTimer.Stop() {
		return nil, errors.New("failed to initialise timer")
	}
	watcher, err := fsnotify.NewWatcher()
	if err != nil {
		return nil, errors.Errorf("failed to create file watcher: %w", err)
	}
	return &debounceFileWatcher{
		watcher:      watcher,
		ErrCh:        watcher.Errors,
		restartTimer: restartTimer,
		RestartCh:    restartTimer.C,
	}, nil
}

func (w *debounceFileWatcher) Start() {
	for {
		event, ok := <-w.watcher.Events
		if !isIgnoredFileEvent(event) {
			fmt.Fprintf(os.Stderr, "File change detected: %s (%s)\n", event.Name, event.Op.String())
			// Fire immediately when timer is inactive, without blocking this thread
			if active := w.restartTimer.Reset(0); active {
				w.restartTimer.Reset(debounceDuration)
			}
		}
		// Ensure the last event is fired before channel close
		if !ok {
			return
		}
		fmt.Fprintf(utils.GetDebugLogger(), "Ignoring file event: %s (%s)\n", event.Name, event.Op.String())
	}
}

func (w *debounceFileWatcher) SetWatchPaths(watchPaths []string, fsys afero.Fs) error {
	watchLimit := viper.GetUint("FUNCTIONS_WATCH_LIMIT")
	if watchLimit == 0 {
		watchLimit = maxFileLimit
	}
	shouldWatchDirs := make(map[string]struct{})
	for _, hostPath := range watchPaths {
		// Ignore non-existent paths and symlink directories
		if err := afero.Walk(fsys, hostPath, func(path string, info fs.FileInfo, err error) error {
			if errors.Is(err, os.ErrNotExist) || slices.Contains(ignoredDirNames, filepath.Base(path)) {
				return nil
			} else if err != nil {
				return errors.Errorf("failed to walk path: %w", err)
			}
			if info.IsDir() {
				shouldWatchDirs[path] = struct{}{}
			} else if path == hostPath {
				shouldWatchDirs[filepath.Dir(path)] = struct{}{}
			}
			if uint(len(shouldWatchDirs)) >= watchLimit {
				return errors.Errorf("file watcher stopped at %s: %w", path, errTooManyFiles)
			}
			return nil
		}); errors.Is(err, errTooManyFiles) {
			fmt.Fprintf(os.Stderr, "%s\nYou can increase this limit by setting SUPABASE_FUNCTIONS_WATCH_LIMIT=%d", err.Error(), watchLimit<<2)
		} else if err != nil {
			return err
		}
	}
	// Add directories to watch, ignoring duplicates
	for hostPath := range shouldWatchDirs {
		if err := w.watcher.Add(hostPath); err != nil {
			return errors.Errorf("failed to watch directory: %w", err)
		}
		fmt.Fprintln(utils.GetDebugLogger(), "Added directory from watcher:", hostPath)
	}
	// Remove directories that are no longer needed
	for _, hostPath := range w.watcher.WatchList() {
		if _, ok := shouldWatchDirs[hostPath]; !ok {
			if err := w.watcher.Remove(hostPath); err != nil {
				return errors.Errorf("failed to remove watch directory: %w", err)
			}
			fmt.Fprintln(utils.GetDebugLogger(), "Removed directory from watcher:", hostPath)
		}
	}
	return nil
}

func (r *debounceFileWatcher) Close() error {
	// Don't stop the timer to allow debounced events to fire
	return r.watcher.Close()
}
