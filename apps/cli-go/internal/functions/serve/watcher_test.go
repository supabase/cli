package serve

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/fsnotify/fsnotify"
	"github.com/spf13/afero"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// Integration test setup for watcher functionality
type WatcherIntegrationSetup struct {
	T       *testing.T
	Context context.Context
	Cancel  context.CancelFunc
	TempDir string
}

func NewWatcherIntegrationSetup(t *testing.T) *WatcherIntegrationSetup {
	ctx, cancel := context.WithCancel(context.Background())
	tempDir := t.TempDir()

	setup := &WatcherIntegrationSetup{
		T:       t,
		Context: ctx,
		Cancel:  cancel,
		TempDir: tempDir,
	}

	return setup
}

func (s *WatcherIntegrationSetup) Cleanup() {
	s.Cancel()
}

// SetupFunctionsDirectory creates a functions directory with test functions
func (s *WatcherIntegrationSetup) SetupFunctionsDirectory() string {
	functionsDir := filepath.Join(s.TempDir, "supabase", "functions")
	require.NoError(s.T, os.MkdirAll(functionsDir, 0755))

	// Set up test functions
	s.createFunction("hello", `export default () => new Response("Hello World")`)
	s.createFunction("protected", `export default () => new Response("Protected")`)

	return functionsDir
}

func (s *WatcherIntegrationSetup) SetupSupabaseDirectory() string {
	supabaseDir := filepath.Join(s.TempDir, "supabase")
	require.NoError(s.T, os.MkdirAll(supabaseDir, 0755))

	return supabaseDir
}

func (s *WatcherIntegrationSetup) createFunction(name, content string) {
	funcDir := filepath.Join(s.TempDir, "supabase", "functions", name)
	require.NoError(s.T, os.MkdirAll(funcDir, 0755))
	require.NoError(s.T, os.WriteFile(filepath.Join(funcDir, "index.ts"), []byte(content), 0600))
}

// CreateFileWatcher creates and configures a debounce file watcher for testing
func (s *WatcherIntegrationSetup) CreateFileWatcher() (*debounceFileWatcher, error) {
	watcher, err := NewDebounceFileWatcher()
	if err != nil {
		return nil, err
	}

	// Set up watch paths to include our test directory
	fsys := afero.NewOsFs()
	watchPaths := []string{s.TempDir}

	if err := watcher.SetWatchPaths(watchPaths, fsys); err != nil {
		watcher.Close()
		return nil, err
	}

	return watcher, nil
}

func TestFileWatcher(t *testing.T) {
	t.Run("detects TypeScript function changes and triggers restart", func(t *testing.T) {
		setup := NewWatcherIntegrationSetup(t)
		defer setup.Cleanup()

		functionsDir := setup.SetupFunctionsDirectory()
		watcher, err := setup.CreateFileWatcher()
		require.NoError(t, err)

		// Modify a function file in background
		go func() {
			defer watcher.Close()
			funcFile := filepath.Join(functionsDir, "hello", "index.ts")
			newContent := `export default () => new Response("Hello Modified World")`
			require.NoError(t, os.WriteFile(funcFile, []byte(newContent), 0600))
			// https://github.com/fsnotify/fsnotify/blob/main/fsnotify_test.go#L181
			time.Sleep(50 * time.Millisecond)
		}()

		// Run watcher on main thread to avoid sleeping
		watcher.Start()

		// Wait for restart signal
		select {
		case ts, ok := <-watcher.RestartCh:
			assert.NotZero(t, ts, "file change should trigger restart")
			assert.True(t, ok, "timer channel should be closed")
		case <-time.After(2 * time.Second):
			assert.Fail(t, "missing restart signal after modifying TypeScript file")
		}
	})

	t.Run("ignores editor temporary files", func(t *testing.T) {
		watcher, err := NewDebounceFileWatcher()
		require.NoError(t, err)

		// Create various temporary/editor files that should be ignored
		go func() {
			defer watcher.Close()
			tempFiles := []string{
				filepath.Join("/tmp", "test.txt~"),       // Backup file
				filepath.Join("/tmp", ".test.swp"),       // Vim swap
				filepath.Join("/tmp", ".#test.ts"),       // Emacs lock
				filepath.Join("/tmp", "test.tmp"),        // Temp file
				filepath.Join("/tmp", "___deno_temp___"), // Deno temp
			}
			for _, tempFile := range tempFiles {
				// Fire events directly since we only care about ignore files
				watcher.watcher.Events <- fsnotify.Event{
					Name: tempFile,
					Op:   fsnotify.Create,
				}
			}
		}()

		// Run watcher on main thread to avoid sleeping
		watcher.Start()

		// Wait multiple times for out of order events
		for range 3 {
			select {
			case <-watcher.RestartCh:
				assert.Fail(t, "should not receive any restart signals from ignored files")
			case err := <-watcher.ErrCh:
				assert.NoError(t, err)
			}
		}
	})

	t.Run("detects config file changes and triggers restart", func(t *testing.T) {
		setup := NewWatcherIntegrationSetup(t)
		defer setup.Cleanup()

		supabaseDir := setup.SetupSupabaseDirectory()
		watcher, err := setup.CreateFileWatcher()
		require.NoError(t, err)

		// Create and modify a config.toml file
		go func() {
			defer watcher.Close()
			configFile := filepath.Join(supabaseDir, "config.toml")
			require.NoError(t, os.WriteFile(configFile, []byte(`
				[functions.hello]
				enabled = true
				verify_jwt = false
			`), 0600))
			// https://github.com/fsnotify/fsnotify/blob/main/fsnotify_test.go#L181
			time.Sleep(50 * time.Millisecond)
		}()

		// Run watcher on main thread to avoid sleeping
		watcher.Start()

		// Wait for restart signal
		select {
		case ts, ok := <-watcher.RestartCh:
			assert.NotZero(t, ts, "config change should trigger restart")
			assert.True(t, ok, "timer channel should be closed")
		case <-time.After(2 * time.Second):
			assert.Fail(t, "missing restart signal after modifying config file")
		}
	})

	t.Run("debounces rapid file changes", func(t *testing.T) {
		watcher, err := NewDebounceFileWatcher()
		require.NoError(t, err)

		// Make rapid changes to a file
		go func() {
			defer watcher.Close()
			for range 5 {
				watcher.watcher.Events <- fsnotify.Event{
					Name: filepath.Join("/tmp", "index.ts"),
					Op:   fsnotify.Write,
				}
			}
		}()

		// Run watcher on main thread to avoid sleeping
		watcher.Start()

		// Wait for debounce duration
		select {
		case ts, ok := <-watcher.RestartCh:
			assert.NotZero(t, ts)
			assert.True(t, ok)
		case <-time.After(debounceDuration):
			assert.Fail(t, "missing restart signal after rapid file changes")
		}
		select {
		case <-watcher.RestartCh:
			assert.Fail(t, "should only get one restart signal due to debouncing")
		case ts, ok := <-time.After(debounceDuration):
			assert.NotZero(t, ts)
			assert.True(t, ok)
		}
	})

	t.Run("watches multiple directories", func(t *testing.T) {
		setup := NewWatcherIntegrationSetup(t)
		defer setup.Cleanup()

		// Create multiple directories with functions
		functionsDir := setup.SetupFunctionsDirectory()
		libDir := filepath.Join(setup.TempDir, "lib")
		require.NoError(t, os.MkdirAll(libDir, 0755))

		// Create a utility file in lib directory
		utilFile := filepath.Join(libDir, "utils.ts")
		require.NoError(t, os.WriteFile(utilFile, []byte(`export function util() { return "utility"; }`), 0600))

		watcher, err := NewDebounceFileWatcher()
		require.NoError(t, err)

		go func() {
			defer watcher.Close()
			// Set up watch paths to include both directories
			fsys := afero.NewOsFs()
			watchPaths := []string{functionsDir, libDir}
			require.NoError(t, watcher.SetWatchPaths(watchPaths, fsys))
			// Modify file in lib directory
			require.NoError(t, os.WriteFile(utilFile, []byte(`export function util() { return "modified utility"; }`), 0600))
			// https://github.com/fsnotify/fsnotify/blob/main/fsnotify_test.go#L181
			time.Sleep(50 * time.Millisecond)
		}()

		// Run watcher on main thread to avoid sleeping
		watcher.Start()

		// Wait for restart signal
		select {
		case ts, ok := <-watcher.RestartCh:
			assert.NotZero(t, ts, "change in watched lib directory should trigger restart")
			assert.True(t, ok, "timer channel should be closed")
		case <-time.After(2 * time.Second):
			assert.Fail(t, "missing restart signal after modifying file in watched lib directory")
		}
	})
}
