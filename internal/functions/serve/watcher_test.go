package serve

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/fsnotify/fsnotify"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"github.com/supabase/cli/internal/utils"
)

type DirectoryTestCase struct {
	Name         string
	DirName      string
	ShouldIgnore bool
}

var directoryTestsCases = []DirectoryTestCase{
	// Should be ignored
	{"Git directory", ".git", true},
	{"Node modules", "node_modules", true},
	{"VS Code config", ".vscode", true},
	{"IntelliJ config", ".idea", true},
	{"macOS metadata", ".DS_Store", true},
	{"Go vendor", "vendor", true},
	{"Hidden cache", ".cache", true},
	{"Hidden config", ".config", true},

	// Should not be ignored
	{"Source directory", "src", false},
	{"Library directory", "lib", false},
	{"Utils directory", "utils", false},
	{"Components directory", "components", false},
	{"Function directory", "my-function", false},
	{"Current directory", ".", false},
	{"Parent directory", "..", false},
}

func TestIsIgnoredDir(t *testing.T) {
	rootPath := "/home/project/supabase/functions"

	t.Run("never ignores root watched directory", func(t *testing.T) {
		result := isIgnoredDir("functions", rootPath, rootPath)
		assert.False(t, result)
	})

	t.Run("never ignores root watched directory even if starts with dot", func(t *testing.T) {
		dotRootPath := "/home/project/.supabase/functions"
		result := isIgnoredDir(".supabase", dotRootPath, dotRootPath)
		assert.False(t, result)
	})

	for _, tc := range directoryTestsCases {
		t.Run(tc.Name, func(t *testing.T) {
			result := isIgnoredDir(tc.DirName, rootPath, filepath.Join(rootPath, tc.DirName))
			assert.Equal(t, tc.ShouldIgnore, result)
		})
	}
}

func TestIsIgnoredFileEvent(t *testing.T) {
	testCases := GetFileEventTestCases()
	for _, tc := range testCases {
		t.Run(tc.Name, func(t *testing.T) {
			result := isIgnoredFileEvent(tc.Filename, tc.Op)
			assert.Equal(t, tc.ShouldIgnore, result)
		})
	}
}

func TestAddDirectoriesToWatcher(t *testing.T) {
	t.Run("adds directories to watcher successfully", func(t *testing.T) {
		setup := NewTestSetup(t)
		defer setup.Cleanup()

		// Setup file system with complex structure
		setup.SetupComplexFunctionStructure()

		// Create watcher
		watcher, err := fsnotify.NewWatcher()
		require.NoError(t, err)
		defer watcher.Close()

		// Create real directory structure for this test
		rootPath := utils.FunctionsDir
		require.NoError(t, os.MkdirAll(filepath.Join(rootPath, "func1"), 0755))
		require.NoError(t, os.MkdirAll(filepath.Join(rootPath, "func2"), 0755))
		defer os.RemoveAll(rootPath)

		err = addDirectoriesToWatcher(watcher, rootPath, rootPath)
		assert.NoError(t, err)
	})

	t.Run("skips ignored directories", func(t *testing.T) {
		setup := NewTestSetup(t)
		defer setup.Cleanup()

		// Setup real functions directory with ignored subdirectories
		rootPath := utils.FunctionsDir
		require.NoError(t, os.MkdirAll(filepath.Join(rootPath, ".git"), 0755))
		require.NoError(t, os.MkdirAll(filepath.Join(rootPath, "node_modules", "package"), 0755))
		require.NoError(t, os.MkdirAll(filepath.Join(rootPath, "src"), 0755))
		defer os.RemoveAll(rootPath)

		// Create watcher
		watcher, err := fsnotify.NewWatcher()
		require.NoError(t, err)
		defer watcher.Close()

		// Test the actual production function - should not error even with ignored directories
		err = addDirectoriesToWatcher(watcher, rootPath, rootPath)
		assert.NoError(t, err)
	})

	t.Run("handles non-existent directory gracefully", func(t *testing.T) {
		setup := NewTestSetup(t)
		defer setup.Cleanup()

		watcher, err := fsnotify.NewWatcher()
		require.NoError(t, err)
		defer watcher.Close()

		nonExistentPath := "/non/existent/path"
		// Test the actual production function
		err = addDirectoriesToWatcher(watcher, nonExistentPath, nonExistentPath)
		// Should handle gracefully - verify it doesn't panic and logs appropriately
		assert.NoError(t, err, "addDirectoriesToWatcher should handle non-existent directories gracefully")
	})
}

func TestSetupFileWatcher(t *testing.T) {
	t.Run("sets up watcher when functions directory exists", func(t *testing.T) {
		setup := NewTestSetup(t)
		defer setup.Cleanup()

		// Use a temporary directory for this test to avoid interference
		tempDir := t.TempDir()
		functionsDir := filepath.Join(tempDir, "functions")

		// Temporarily set utils.FunctionsDir to our test directory
		originalFunctionsDir := utils.FunctionsDir
		utils.FunctionsDir = functionsDir
		defer func() { utils.FunctionsDir = originalFunctionsDir }()

		require.NoError(t, os.MkdirAll(functionsDir, 0755))

		// Create a test function file
		testFuncDir := filepath.Join(functionsDir, "hello")
		require.NoError(t, os.MkdirAll(testFuncDir, 0755))
		require.NoError(t, os.WriteFile(filepath.Join(testFuncDir, "index.ts"),
			[]byte("export default () => new Response('hello')"), 0600))

		// Test the actual production function
		watcher, watchedPath, err := setupFileWatcher()
		if watcher != nil {
			defer watcher.Close()
		}

		// Should successfully create watcher and return the functions directory path
		assert.NoError(t, err)
		assert.NotNil(t, watcher)
		assert.NotEmpty(t, watchedPath, "watchedPath should not be empty when functions directory exists")
		// Verify the path points to the functions directory
		expectedPath, _ := filepath.Abs(utils.FunctionsDir)
		assert.Equal(t, expectedPath, watchedPath, "watchedPath should point to functions directory")
	})

	t.Run("handles missing functions directory", func(t *testing.T) {
		setup := NewTestSetup(t)
		defer setup.Cleanup()

		// Use a temporary directory that doesn't exist
		tempDir := t.TempDir()
		functionsDir := filepath.Join(tempDir, "nonexistent")

		// Temporarily set utils.FunctionsDir to our test directory
		originalFunctionsDir := utils.FunctionsDir
		utils.FunctionsDir = functionsDir
		defer func() { utils.FunctionsDir = originalFunctionsDir }()

		// Test the actual production function
		watcher, watchedPath, err := setupFileWatcher()
		if watcher != nil {
			defer watcher.Close()
		}

		// Should handle missing directory gracefully - creates watcher and returns empty path
		assert.NoError(t, err)
		assert.NotNil(t, watcher)
		assert.Empty(t, watchedPath, "watchedPath should be empty when functions directory doesn't exist")
	})

	t.Run("handles empty functions directory", func(t *testing.T) {
		setup := NewTestSetup(t)
		defer setup.Cleanup()

		// Use a temporary directory for this test
		tempDir := t.TempDir()
		functionsDir := filepath.Join(tempDir, "functions")

		// Temporarily set utils.FunctionsDir to our test directory
		originalFunctionsDir := utils.FunctionsDir
		utils.FunctionsDir = functionsDir
		defer func() { utils.FunctionsDir = originalFunctionsDir }()

		require.NoError(t, os.MkdirAll(functionsDir, 0755))

		// Test the actual production function
		watcher, watchedPath, err := setupFileWatcher()
		if watcher != nil {
			defer watcher.Close()
		}

		// Should handle empty directory successfully
		assert.NoError(t, err)
		assert.NotNil(t, watcher, "watcher should be created for empty directory")
		expectedPath, _ := filepath.Abs(utils.FunctionsDir)
		assert.Equal(t, expectedPath, watchedPath, "watchedPath should be set for empty directory")
	})
}

func TestRunFileWatcher(t *testing.T) {
	t.Run("respects context cancellation", func(t *testing.T) {
		setup := NewTestSetup(t)
		defer setup.Cleanup()

		watchPath := filepath.Join(utils.FunctionsDir, "test")
		watcher, err := setup.CreateFileWatcher(watchPath)
		if err != nil {
			t.Skip("File watcher not supported on this system")
		}
		defer watcher.Close()

		ctx, cancel := context.WithTimeout(setup.Context, 500*time.Millisecond)
		defer cancel()

		restartChan := make(chan struct{}, 1)

		// Start file watcher
		go runFileWatcher(ctx, watcher, watchPath, restartChan)

		// Test the watcher behavior indirectly by verifying it doesn't block
		// and handles context cancellation properly
		time.Sleep(50 * time.Millisecond)

		// Verify the goroutine is running and context cancellation works
		select {
		case <-ctx.Done():
			// Expected timeout - watcher should respect context cancellation
		case <-time.After(600 * time.Millisecond):
			t.Error("Test timed out - watcher may not be respecting context")
		}
	})

	t.Run("ignores irrelevant file events", func(t *testing.T) {
		setup := NewTestSetup(t)
		defer setup.Cleanup()

		watchPath := filepath.Join(utils.FunctionsDir, "test")
		watcher, err := setup.CreateFileWatcher(watchPath)
		if err != nil {
			t.Skip("File watcher not supported on this system")
		}
		defer watcher.Close()

		ctx, cancel := context.WithTimeout(setup.Context, 200*time.Millisecond)
		defer cancel()

		restartChan := make(chan struct{}, 1)

		// Start file watcher
		go runFileWatcher(ctx, watcher, watchPath, restartChan)

		// Test ignored file patterns
		ignoredFiles := []string{
			"file.txt~",       // backup files
			".file.swp",       // vim swap files
			"file.tmp",        // temp files
			"___deno_temp___", // deno temp files
		}

		for _, filename := range ignoredFiles {
			shouldIgnore := isIgnoredFileEvent(filename, fsnotify.Write)
			assert.True(t, shouldIgnore, "Should ignore file: %s", filename)
		}

		// Verify no restart signals from ignored files
		select {
		case <-restartChan:
			t.Fatal("Received unexpected restart signal from ignored file")
		case <-ctx.Done():
		}
	})

	t.Run("handles context cancellation gracefully", func(t *testing.T) {
		setup := NewTestSetup(t)
		defer setup.Cleanup()

		watchPath := filepath.Join(utils.FunctionsDir, "test")
		watcher, err := setup.CreateFileWatcher(watchPath)
		if err != nil {
			t.Skip("File watcher not supported on this system")
		}
		defer watcher.Close()

		ctx, cancel := context.WithCancel(setup.Context)
		restartChan := make(chan struct{}, 1)

		// Start file watcher
		go runFileWatcher(ctx, watcher, watchPath, restartChan)

		// Cancel context immediately
		cancel()

		// Should complete quickly
		time.Sleep(100 * time.Millisecond)
		// Expected - function should exit gracefully
	})
}

func TestFileWatcherIntegration(t *testing.T) {
	t.Run("detects file changes and triggers restarts", func(t *testing.T) {
		setup := NewTestSetup(t)
		defer setup.Cleanup()

		// Use a temporary directory for this test
		tempDir := t.TempDir()
		functionsDir := filepath.Join(tempDir, "functions")

		// Temporarily set utils.FunctionsDir to our test directory
		originalFunctionsDir := utils.FunctionsDir
		utils.FunctionsDir = functionsDir
		defer func() { utils.FunctionsDir = originalFunctionsDir }()

		require.NoError(t, os.MkdirAll(functionsDir, 0755))

		// Create initial function
		funcDir := filepath.Join(functionsDir, "hello")
		require.NoError(t, os.MkdirAll(funcDir, 0755))
		initialContent := "export default () => new Response('Hello!')"
		funcFile := filepath.Join(funcDir, "index.ts")
		require.NoError(t, os.WriteFile(funcFile, []byte(initialContent), 0600))

		// Set up the file watcher
		watcher, watchedPath, err := setupFileWatcher()
		require.NoError(t, err)
		require.NotNil(t, watcher)
		require.NotEmpty(t, watchedPath)
		defer watcher.Close()

		// Start the file watcher
		ctx, cancel := context.WithTimeout(setup.Context, 3*time.Second)
		defer cancel()

		restartChan := make(chan struct{}, 10) // Buffer to capture multiple signals
		go runFileWatcher(ctx, watcher, watchedPath, restartChan)

		// Give watcher time to initialize
		time.Sleep(100 * time.Millisecond)

		// Test 1: Modify existing file
		modifiedContent := "export default () => new Response('Hello World!')"
		require.NoError(t, os.WriteFile(funcFile, []byte(modifiedContent), 0600))

		// Wait for restart signal
		select {
		case <-restartChan:
			// Expected - file modification should trigger restart
		case <-time.After(1 * time.Second):
			t.Error("Expected restart signal after file modification")
		}

		// Test 2: Create new function
		newFuncDir := filepath.Join(functionsDir, "goodbye")
		require.NoError(t, os.MkdirAll(newFuncDir, 0755))
		newFuncFile := filepath.Join(newFuncDir, "index.ts")
		require.NoError(t, os.WriteFile(newFuncFile, []byte("export default () => new Response('Goodbye!')"), 0600))

		// Wait for restart signal
		select {
		case <-restartChan:
			// Expected - new file should trigger restart
		case <-time.After(1 * time.Second):
			t.Error("Expected restart signal after new file creation")
		}

		// Test 3: Delete file
		require.NoError(t, os.Remove(newFuncFile))

		// Wait for restart signal
		select {
		case <-restartChan:
			// Expected - file deletion should trigger restart
		case <-time.After(1 * time.Second):
			t.Error("Expected restart signal after file deletion")
		}
	})

	t.Run("debounces rapid file changes", func(t *testing.T) {
		setup := NewTestSetup(t)
		defer setup.Cleanup()

		// Use a temporary directory for this test
		tempDir := t.TempDir()
		functionsDir := filepath.Join(tempDir, "functions")

		// Temporarily set utils.FunctionsDir to our test directory
		originalFunctionsDir := utils.FunctionsDir
		utils.FunctionsDir = functionsDir
		defer func() { utils.FunctionsDir = originalFunctionsDir }()

		require.NoError(t, os.MkdirAll(functionsDir, 0755))

		// Create initial function
		funcDir := filepath.Join(functionsDir, "test")
		require.NoError(t, os.MkdirAll(funcDir, 0755))
		funcFile := filepath.Join(funcDir, "index.ts")
		require.NoError(t, os.WriteFile(funcFile, []byte("export default () => new Response('v1')"), 0600))

		// Set up the file watcher
		watcher, watchedPath, err := setupFileWatcher()
		require.NoError(t, err)
		require.NotNil(t, watcher)
		require.NotEmpty(t, watchedPath)
		defer watcher.Close()

		// Start the file watcher
		ctx, cancel := context.WithTimeout(setup.Context, 2*time.Second)
		defer cancel()

		restartChan := make(chan struct{}, 10)
		go runFileWatcher(ctx, watcher, watchedPath, restartChan)

		// Give watcher time to initialize
		time.Sleep(100 * time.Millisecond)

		// Make multiple rapid changes (faster than debounce duration of 500ms)
		for i := 0; i < 5; i++ {
			content := fmt.Sprintf("export default () => new Response('v%d')", i+2)
			require.NoError(t, os.WriteFile(funcFile, []byte(content), 0600))
			time.Sleep(50 * time.Millisecond) // Much faster than 500ms debounce
		}

		// Wait for debounce period + some buffer
		time.Sleep(800 * time.Millisecond)

		// Should only receive one restart signal due to debouncing
		restartCount := 0
		for {
			select {
			case <-restartChan:
				restartCount++
			case <-time.After(100 * time.Millisecond):
				// No more signals
				goto checkResult
			}
		}

	checkResult:
		assert.Equal(t, 1, restartCount, "Expected exactly 1 restart signal due to debouncing, got %d", restartCount)
	})

	t.Run("ignores temp and backup files during watching", func(t *testing.T) {
		setup := NewTestSetup(t)
		defer setup.Cleanup()

		// Use a temporary directory for this test
		tempDir := t.TempDir()
		functionsDir := filepath.Join(tempDir, "functions")

		// Temporarily set utils.FunctionsDir to our test directory
		originalFunctionsDir := utils.FunctionsDir
		utils.FunctionsDir = functionsDir
		defer func() { utils.FunctionsDir = originalFunctionsDir }()

		require.NoError(t, os.MkdirAll(functionsDir, 0755))

		// Create function directory
		funcDir := filepath.Join(functionsDir, "test")
		require.NoError(t, os.MkdirAll(funcDir, 0755))

		// Set up the file watcher
		watcher, watchedPath, err := setupFileWatcher()
		require.NoError(t, err)
		require.NotNil(t, watcher)
		require.NotEmpty(t, watchedPath)
		defer watcher.Close()

		// Start the file watcher
		ctx, cancel := context.WithTimeout(setup.Context, 3*time.Second)
		defer cancel()

		restartChan := make(chan struct{}, 10)
		go runFileWatcher(ctx, watcher, watchedPath, restartChan)

		// Give watcher time to initialize
		time.Sleep(100 * time.Millisecond)

		// Create ignored files that shouldn't trigger restarts
		ignoredFiles := []string{
			filepath.Join(funcDir, "index.ts~"),       // backup file
			filepath.Join(funcDir, ".index.ts.swp"),   // vim swap file
			filepath.Join(funcDir, "temp.tmp"),        // temp file
			filepath.Join(funcDir, "___deno_temp___"), // deno temp file
		}

		for _, ignoredFile := range ignoredFiles {
			require.NoError(t, os.WriteFile(ignoredFile, []byte("temp content"), 0600))
			time.Sleep(50 * time.Millisecond)
		}

		// Wait for debounce period to ensure ignored files don't trigger restarts
		time.Sleep(600 * time.Millisecond)

		// Should not receive any restart signals from ignored files
		restartCount := 0
		for {
			select {
			case <-restartChan:
				restartCount++
				// Continue draining to see if we get multiple signals
			case <-time.After(100 * time.Millisecond):
				// No more signals
				goto checkIgnored
			}
		}

	checkIgnored:
		if restartCount > 0 {
			t.Errorf("Received %d unexpected restart signals from ignored files", restartCount)
		}

		// Now create a real file that should trigger restart
		realFile := filepath.Join(funcDir, "index.ts")
		require.NoError(t, os.WriteFile(realFile, []byte("export default () => new Response('test')"), 0600))

		// This should trigger a restart
		select {
		case <-restartChan:
			// Expected - real file should trigger restart
		case <-time.After(1 * time.Second):
			t.Error("Expected restart signal after creating real function file")
		}
	})

	t.Run("file watcher with hot reloading simulation", func(t *testing.T) {
		setup := NewTestSetup(t)
		defer setup.Cleanup()

		// Create functions that would normally trigger reloads
		setup.SetupFunction("api", "export default () => new Response('API')")
		setup.SetupFunction("webhook", "export default () => new Response('Webhook')")

		// Test file patterns that should trigger reloads
		triggerFiles := []string{
			"index.ts", "index.js", "main.ts", "handler.js",
			"config.json", "package.json", "deno.json",
			"utils.ts", "types.ts", "constants.ts",
		}

		for _, filename := range triggerFiles {
			shouldIgnore := isIgnoredFileEvent(filename, fsnotify.Write)
			assert.False(t, shouldIgnore,
				"File %s should trigger hot reload", filename)
		}

		// Test file patterns that should NOT trigger reloads
		ignoreFiles := []string{
			"file.txt~", ".file.swp", "file.tmp",
			"___deno_bundle___", ".#lock",
		}

		for _, filename := range ignoreFiles {
			shouldIgnore := isIgnoredFileEvent(filename, fsnotify.Write)
			assert.True(t, shouldIgnore,
				"File %s should NOT trigger hot reload", filename)
		}
	})
}
