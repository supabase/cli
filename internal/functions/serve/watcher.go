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
		if event.Has(restartEvents) && !isIgnoredFileEvent(event.Name, event.Op) {
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
			if err != nil {
				return errors.New(err)
			}
			if slices.Contains(ignoredDirNames, filepath.Base(path)) {
				return nil
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
