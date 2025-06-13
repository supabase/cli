package serve

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"time"

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

func TestFileWatcherIntegration(t *testing.T) {
	t.Run("detects TypeScript function changes and triggers restart", func(t *testing.T) {
		setup := NewWatcherIntegrationSetup(t)
		defer setup.Cleanup()

		functionsDir := setup.SetupFunctionsDirectory()

		watcher, err := setup.CreateFileWatcher()
		require.NoError(t, err)
		defer watcher.Close()

		// Start the watcher
		ctx, cancel := context.WithTimeout(setup.Context, 5*time.Second)
		defer cancel()

		go watcher.Start(ctx)

		// Give watcher time to initialize
		time.Sleep(100 * time.Millisecond)

		// Modify a function file
		funcFile := filepath.Join(functionsDir, "hello", "index.ts")
		newContent := `export default () => new Response("Hello Modified World")`
		require.NoError(t, os.WriteFile(funcFile, []byte(newContent), 0600))

		// Wait for restart signal
		select {
		case <-watcher.RestartCh:
			// Expected - file change should trigger restart
		case <-time.After(2 * time.Second):
			t.Error("Expected restart signal after modifying TypeScript file")
		}
	})

	t.Run("ignores editor temporary files", func(t *testing.T) {
		setup := NewWatcherIntegrationSetup(t)
		defer setup.Cleanup()

		functionsDir := setup.SetupFunctionsDirectory()

		watcher, err := setup.CreateFileWatcher()
		require.NoError(t, err)
		defer watcher.Close()

		ctx, cancel := context.WithTimeout(setup.Context, 3*time.Second)
		defer cancel()

		go watcher.Start(ctx)

		// Give watcher time to initialize
		time.Sleep(100 * time.Millisecond)

		// Create various temporary/editor files that should be ignored
		tempFiles := []string{
			filepath.Join(functionsDir, "hello", "test.txt~"),       // Backup file
			filepath.Join(functionsDir, "hello", ".test.swp"),       // Vim swap
			filepath.Join(functionsDir, "hello", ".#test.ts"),       // Emacs lock
			filepath.Join(functionsDir, "hello", "test.tmp"),        // Temp file
			filepath.Join(functionsDir, "hello", "___deno_temp___"), // Deno temp
		}

		for _, tempFile := range tempFiles {
			require.NoError(t, os.WriteFile(tempFile, []byte("temp content"), 0600))
			time.Sleep(50 * time.Millisecond)
		}

		// Wait for debounce period
		time.Sleep(600 * time.Millisecond)

		// Should not receive any restart signals from ignored files
		select {
		case <-watcher.RestartCh:
			t.Error("Received unexpected restart signal from ignored files")
		case <-time.After(100 * time.Millisecond):
			// Expected - no restart for ignored files
		}
	})

	t.Run("detects config file changes and triggers restart", func(t *testing.T) {
		setup := NewWatcherIntegrationSetup(t)
		defer setup.Cleanup()

		supabaseDir := setup.SetupSupabaseDirectory()

		watcher, err := setup.CreateFileWatcher()
		require.NoError(t, err)
		defer watcher.Close()

		ctx, cancel := context.WithTimeout(setup.Context, 3*time.Second)
		defer cancel()

		go watcher.Start(ctx)

		// Give watcher time to initialize
		time.Sleep(100 * time.Millisecond)

		// Create and modify a config.toml file
		configFile := filepath.Join(supabaseDir, "config.toml")
		configContent := `[functions.hello]
enabled = true
verify_jwt = false`
		require.NoError(t, os.WriteFile(configFile, []byte(configContent), 0600))

		// Wait for restart signal
		select {
		case <-watcher.RestartCh:
			// Expected - config change should trigger restart
		case <-time.After(2 * time.Second):
			t.Error("Expected restart signal after modifying config file")
		}
	})

	t.Run("handles file watcher errors gracefully", func(t *testing.T) {
		setup := NewWatcherIntegrationSetup(t)
		defer setup.Cleanup()

		watcher, err := setup.CreateFileWatcher()
		require.NoError(t, err)
		defer watcher.Close()

		ctx, cancel := context.WithTimeout(setup.Context, 1*time.Second)
		defer cancel()

		// Start watcher
		go watcher.Start(ctx)

		// Monitor for errors
		select {
		case err := <-watcher.ErrCh:
			// If we get an error, it should be handled gracefully
			t.Logf("Watcher error (handled gracefully): %v", err)
		case <-ctx.Done():
			// Expected - timeout without critical errors
		}
	})

	t.Run("debounces rapid file changes", func(t *testing.T) {
		setup := NewWatcherIntegrationSetup(t)
		defer setup.Cleanup()

		functionsDir := setup.SetupFunctionsDirectory()

		watcher, err := setup.CreateFileWatcher()
		require.NoError(t, err)
		defer watcher.Close()

		ctx, cancel := context.WithTimeout(setup.Context, 5*time.Second)
		defer cancel()

		go watcher.Start(ctx)

		// Give watcher time to initialize
		time.Sleep(100 * time.Millisecond)

		// Make rapid changes to a file
		funcFile := filepath.Join(functionsDir, "hello", "index.ts")
		for i := 0; i < 5; i++ {
			content := fmt.Sprintf(`export default () => new Response("Hello %d")`, i)
			require.NoError(t, os.WriteFile(funcFile, []byte(content), 0600))
			time.Sleep(50 * time.Millisecond) // Less than debounce duration
		}

		// Should only get one restart signal due to debouncing
		restartCount := 0
		timeout := time.After(1 * time.Second)

		for {
			select {
			case <-watcher.RestartCh:
				restartCount++
				// Continue to see if more signals come through
			case <-timeout:
				// Done counting
				goto done
			}
		}

	done:
		// Should have only one restart signal due to debouncing
		assert.Equal(t, 1, restartCount, "Expected exactly one restart signal due to debouncing")
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
		defer watcher.Close()

		// Set up watch paths to include both directories
		fsys := afero.NewOsFs()
		watchPaths := []string{functionsDir, libDir}
		require.NoError(t, watcher.SetWatchPaths(watchPaths, fsys))

		ctx, cancel := context.WithTimeout(setup.Context, 3*time.Second)
		defer cancel()

		go watcher.Start(ctx)

		// Give watcher time to initialize
		time.Sleep(100 * time.Millisecond)

		// Modify file in lib directory
		require.NoError(t, os.WriteFile(utilFile, []byte(`export function util() { return "modified utility"; }`), 0600))

		// Wait for restart signal
		select {
		case <-watcher.RestartCh:
			// Expected - change in watched lib directory should trigger restart
		case <-time.After(2 * time.Second):
			t.Error("Expected restart signal after modifying file in watched lib directory")
		}
	})

	t.Run("stops watching when context is cancelled", func(t *testing.T) {
		setup := NewWatcherIntegrationSetup(t)
		defer setup.Cleanup()

		setup.SetupFunctionsDirectory()

		watcher, err := setup.CreateFileWatcher()
		require.NoError(t, err)
		defer watcher.Close()

		ctx, cancel := context.WithTimeout(setup.Context, 500*time.Millisecond)
		defer cancel()

		// Start watcher - it should respect context cancellation
		go watcher.Start(ctx)

		// Wait for context to be cancelled
		<-ctx.Done()

		// Watcher should have stopped gracefully
		// This test mainly ensures no goroutine leaks or panics occur
	})
}
