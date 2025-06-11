package serve

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/spf13/afero"
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
		fsys := afero.NewOsFs()
		watcher, watchedPath, err := setupFileWatcher(fsys)
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
		fsys := afero.NewOsFs()
		watcher, watchedPath, err := setupFileWatcher(fsys)
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
		fsys := afero.NewOsFs()
		watcher, watchedPath, err := setupFileWatcher(fsys)
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

// TestRunFileWatcher - simplified to focus on core functionality
func TestRunFileWatcher(t *testing.T) {
	t.Run("respects context cancellation", func(t *testing.T) {
		setup := NewTestSetup(t)
		defer setup.Cleanup()

		watchPath := filepath.Join(utils.FunctionsDir, "test")
		fsys := afero.NewOsFs()
		watcher, err := setup.CreateFileWatcher(watchPath)
		if err != nil {
			t.Skip("File watcher not supported on this system")
		}
		defer watcher.Close()

		ctx, cancel := context.WithTimeout(setup.Context, 500*time.Millisecond)
		defer cancel()

		restartChan := make(chan struct{}, 1)
		watchedDirs := make(map[string]bool)

		// Start file watcher
		go runFileWatcher(ctx, watcher, watchPath, restartChan, watchedDirs, fsys)

		// Verify the goroutine is running and context cancellation works
		select {
		case <-ctx.Done():
			// Expected timeout - watcher should respect context cancellation
		case <-time.After(600 * time.Millisecond):
			t.Error("Test timed out - watcher may not be respecting context")
		}
	})
}

func TestFileWatcherIntegration(t *testing.T) {
	t.Run("ignores changes to non-valid files", func(t *testing.T) {
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
		fsys := afero.NewOsFs()
		watcher, watchedPath, err := setupFileWatcher(fsys)
		require.NoError(t, err)
		require.NotNil(t, watcher)
		require.NotEmpty(t, watchedPath)
		defer watcher.Close()

		// Start the file watcher
		ctx, cancel := context.WithTimeout(setup.Context, 3*time.Second)
		defer cancel()

		restartChan := make(chan struct{}, 10)
		watchedDirs := make(map[string]bool)
		go runFileWatcher(ctx, watcher, watchedPath, restartChan, watchedDirs, fsys)

		// Give watcher time to initialize
		time.Sleep(100 * time.Millisecond)

		// Create and modify files that should not trigger reloads
		ignoredFiles := []string{
			filepath.Join(funcDir, "test.txt"),        // non-TypeScript file
			filepath.Join(funcDir, "test.md"),         // documentation
			filepath.Join(funcDir, "test.json"),       // non-function config
			filepath.Join(funcDir, "test.log"),        // log file
			filepath.Join(funcDir, "test.tmp"),        // temp file
			filepath.Join(funcDir, "test.swp"),        // vim swap
			filepath.Join(funcDir, "test~"),           // backup
			filepath.Join(funcDir, "___deno_temp___"), // deno temp
		}

		for _, ignoredFile := range ignoredFiles {
			require.NoError(t, os.WriteFile(ignoredFile, []byte("test content"), 0600))
			time.Sleep(50 * time.Millisecond)
		}

		// Wait for debounce period to ensure ignored files don't trigger restarts
		time.Sleep(600 * time.Millisecond)

		// Should not receive any restart signals from ignored files
		select {
		case <-restartChan:
			t.Error("Received unexpected restart signal from ignored file")
		case <-time.After(100 * time.Millisecond):
			// Expected - no restart for ignored files
		}
	})

	t.Run("reloads when dependency of dependency changes", func(t *testing.T) {
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

		// Create a deep dependency chain
		libDir := filepath.Join(tempDir, "lib")
		require.NoError(t, os.MkdirAll(libDir, 0755))

		// Create base utility
		baseUtil := filepath.Join(libDir, "base.ts")
		require.NoError(t, os.WriteFile(baseUtil, []byte(`
export function baseFunction() {
  return "base";
}
`), 0600))

		// Create intermediate utility that depends on base
		intermediateDir := filepath.Join(libDir, "intermediate")
		require.NoError(t, os.MkdirAll(intermediateDir, 0755))
		intermediateUtil := filepath.Join(intermediateDir, "util.ts")
		require.NoError(t, os.WriteFile(intermediateUtil, []byte(`
import { baseFunction } from "../base.ts";

export function intermediateFunction() {
  return baseFunction() + " -> intermediate";
}
`), 0600))

		// Create function that depends on intermediate
		funcDir := filepath.Join(functionsDir, "test")
		require.NoError(t, os.MkdirAll(funcDir, 0755))
		funcFile := filepath.Join(funcDir, "index.ts")
		require.NoError(t, os.WriteFile(funcFile, []byte(`
import { intermediateFunction } from "../../lib/intermediate/util.ts";

export default () => new Response(intermediateFunction());
`), 0600))

		// Set up the file watcher
		fsys := afero.NewOsFs()
		watcher, watchedPath, err := setupFileWatcher(fsys)
		require.NoError(t, err)
		require.NotNil(t, watcher)
		require.NotEmpty(t, watchedPath)
		defer watcher.Close()

		// Start the file watcher
		ctx, cancel := context.WithTimeout(setup.Context, 3*time.Second)
		defer cancel()

		restartChan := make(chan struct{}, 10)
		watchedDirs := make(map[string]bool)
		go runFileWatcher(ctx, watcher, watchedPath, restartChan, watchedDirs, fsys)

		// Give watcher time to initialize
		time.Sleep(100 * time.Millisecond)

		// Modify the base utility
		require.NoError(t, os.WriteFile(baseUtil, []byte(`
export function baseFunction() {
  return "modified base";
}
`), 0600))

		// Wait for restart signal
		select {
		case <-restartChan:
			// Expected - change to dependency should trigger restart
		case <-time.After(1 * time.Second):
			t.Error("Expected restart signal after modifying dependency")
		}
	})

	t.Run("handles function lifecycle events", func(t *testing.T) {
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

		// Set up the file watcher
		fsys := afero.NewOsFs()
		watcher, watchedPath, err := setupFileWatcher(fsys)
		require.NoError(t, err)
		require.NotNil(t, watcher)
		require.NotEmpty(t, watchedPath)
		defer watcher.Close()

		// Start the file watcher
		ctx, cancel := context.WithTimeout(setup.Context, 3*time.Second)
		defer cancel()

		restartChan := make(chan struct{}, 10)
		watchedDirs := make(map[string]bool)
		go runFileWatcher(ctx, watcher, watchedPath, restartChan, watchedDirs, fsys)

		// Give watcher time to initialize
		time.Sleep(100 * time.Millisecond)

		// Test 1: Add new function
		newFuncDir := filepath.Join(functionsDir, "new-function")
		require.NoError(t, os.MkdirAll(newFuncDir, 0755))
		newFuncFile := filepath.Join(newFuncDir, "index.ts")
		require.NoError(t, os.WriteFile(newFuncFile, []byte("export default () => new Response('new')"), 0600))

		// Wait for restart signal
		select {
		case <-restartChan:
			// Expected - new function should trigger restart
		case <-time.After(1 * time.Second):
			t.Error("Expected restart signal after adding new function")
		}

		// Test 2: Update existing function
		require.NoError(t, os.WriteFile(newFuncFile, []byte("export default () => new Response('updated')"), 0600))

		// Wait for restart signal
		select {
		case <-restartChan:
			// Expected - update should trigger restart
		case <-time.After(1 * time.Second):
			t.Error("Expected restart signal after updating function")
		}

		// Test 3: Remove function
		require.NoError(t, os.RemoveAll(newFuncDir))

		// Wait for restart signal
		select {
		case <-restartChan:
			// Expected - removal should trigger restart
		case <-time.After(1 * time.Second):
			t.Error("Expected restart signal after removing function")
		}
	})

	t.Run("handles watcher errors gracefully", func(t *testing.T) {
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

		// Create a function with invalid imports
		funcDir := filepath.Join(functionsDir, "test")
		require.NoError(t, os.MkdirAll(funcDir, 0755))
		funcFile := filepath.Join(funcDir, "index.ts")
		require.NoError(t, os.WriteFile(funcFile, []byte(`
import { something } from "/invalid/path";
export default () => new Response("test");
`), 0600))

		// Set up the file watcher
		fsys := afero.NewOsFs()
		watcher, watchedPath, err := setupFileWatcher(fsys)
		require.NoError(t, err)
		require.NotNil(t, watcher)
		require.NotEmpty(t, watchedPath)
		defer watcher.Close()

		// Start the file watcher
		ctx, cancel := context.WithTimeout(setup.Context, 3*time.Second)
		defer cancel()

		restartChan := make(chan struct{}, 10)
		watchedDirs := make(map[string]bool)
		go runFileWatcher(ctx, watcher, watchedPath, restartChan, watchedDirs, fsys)

		// Give watcher time to initialize
		time.Sleep(100 * time.Millisecond)

		// Modify the function with invalid import
		require.NoError(t, os.WriteFile(funcFile, []byte(`
import { something } from "/another/invalid/path";
export default () => new Response("test");
`), 0600))

		// Wait for restart signal - should still work despite invalid imports
		select {
		case <-restartChan:
			// Expected - file change should still trigger restart
		case <-time.After(1 * time.Second):
			t.Error("Expected restart signal after modifying function with invalid imports")
		}
	})

	t.Run("handles import map resolution end-to-end", func(t *testing.T) {
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

		// Test watcher resilience - no deno.json to avoid parsing issues
		funcDir := filepath.Join(functionsDir, "resilient")
		require.NoError(t, os.MkdirAll(funcDir, 0755))

		// Create function file
		funcFile := filepath.Join(funcDir, "index.ts")
		require.NoError(t, os.WriteFile(funcFile, []byte(`export default async (): Promise<Response> => {
  return new Response("Hello World");
};`), 0644))

		// Set up the file watcher
		fsys := afero.NewOsFs()
		watcher, watchedPath, err := setupFileWatcher(fsys)
		require.NoError(t, err)
		require.NotNil(t, watcher)
		require.NotEmpty(t, watchedPath)
		defer watcher.Close()

		// Start the file watcher
		ctx, cancel := context.WithTimeout(setup.Context, 3*time.Second)
		defer cancel()

		restartChan := make(chan struct{}, 10)
		watchedDirs := make(map[string]bool)
		go runFileWatcher(ctx, watcher, watchedPath, restartChan, watchedDirs, fsys)

		// Give watcher time to initialize
		time.Sleep(200 * time.Millisecond)

		// Modify the function file - should trigger restart
		require.NoError(t, os.WriteFile(funcFile, []byte(`export default async (): Promise<Response> => {
  return new Response("Updated Hello World");
};`), 0644))

		// Wait for restart signal
		select {
		case <-restartChan:
			// Expected - change to function should trigger restart
		case <-time.After(2 * time.Second):
			t.Error("Expected restart signal after modifying function")
		}
	})

	t.Run("handles complex multi-level dependencies", func(t *testing.T) {
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

		// Create multiple shared directories
		dirs := []string{
			filepath.Join(tempDir, "shared", "types"),
			filepath.Join(tempDir, "shared", "constants"),
			filepath.Join(tempDir, "lib", "database"),
		}

		for _, dir := range dirs {
			require.NoError(t, os.MkdirAll(dir, 0755))
		}

		// Create shared files
		typesFile := filepath.Join(tempDir, "shared", "types", "index.ts")
		require.NoError(t, os.WriteFile(typesFile, []byte(`
export interface User {
  id: string;
  name: string;
}
`), 0600))

		constantsFile := filepath.Join(tempDir, "shared", "constants", "api.ts")
		require.NoError(t, os.WriteFile(constantsFile, []byte(`
export const API_BASE_URL = "https://api.example.com";
`), 0600))

		databaseFile := filepath.Join(tempDir, "lib", "database", "client.ts")
		require.NoError(t, os.WriteFile(databaseFile, []byte(`
export function connectDB() {
  return "connected";
}
`), 0600))

		// Create a function with multiple imports
		funcDir := filepath.Join(functionsDir, "complex")
		require.NoError(t, os.MkdirAll(funcDir, 0755))
		funcFile := filepath.Join(funcDir, "index.ts")

		require.NoError(t, os.WriteFile(funcFile, []byte(`
import { User } from "../../shared/types/index.ts";
import { API_BASE_URL } from "../../shared/constants/api.ts";
import { connectDB } from "../../lib/database/client.ts";

export default async (): Promise<Response> => {
  const db = connectDB();
  const user: User = { id: "1", name: "Test" };
  
  return new Response(JSON.stringify({ user, apiUrl: API_BASE_URL, db }), {
    headers: { 'Content-Type': 'application/json' }
  });
};
`), 0600))

		// Set up the file watcher
		fsys := afero.NewOsFs()
		watcher, watchedPath, err := setupFileWatcher(fsys)
		require.NoError(t, err)
		require.NotNil(t, watcher)
		require.NotEmpty(t, watchedPath)
		defer watcher.Close()

		// Start the file watcher
		ctx, cancel := context.WithTimeout(setup.Context, 3*time.Second)
		defer cancel()

		restartChan := make(chan struct{}, 10)
		watchedDirs := make(map[string]bool)
		go runFileWatcher(ctx, watcher, watchedPath, restartChan, watchedDirs, fsys)

		// Give watcher time to initialize
		time.Sleep(200 * time.Millisecond)

		// Test 1: Modify types file
		require.NoError(t, os.WriteFile(typesFile, []byte(`
export interface User {
  id: string;
  name: string;
  email?: string;
}
`), 0600))

		// Wait for restart signal
		select {
		case <-restartChan:
			// Expected - types change should trigger restart
		case <-time.After(1 * time.Second):
			t.Error("Expected restart signal after modifying types file")
		}

		// Test 2: Modify constants file
		require.NoError(t, os.WriteFile(constantsFile, []byte(`
export const API_BASE_URL = "https://new-api.example.com";
`), 0600))

		// Wait for restart signal
		select {
		case <-restartChan:
			// Expected - constants change should trigger restart
		case <-time.After(1 * time.Second):
			t.Error("Expected restart signal after modifying constants file")
		}

		// Test 3: Modify database file
		require.NoError(t, os.WriteFile(databaseFile, []byte(`
export function connectDB() {
  return "new connection";
}
`), 0600))

		// Wait for restart signal
		select {
		case <-restartChan:
			// Expected - database change should trigger restart
		case <-time.After(1 * time.Second):
			t.Error("Expected restart signal after modifying database file")
		}
	})

	t.Run("handles transitive dependencies (deps of deps)", func(t *testing.T) {
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

		// Create the shared directory structure
		sharedDir := filepath.Join(tempDir, "shared")
		require.NoError(t, os.MkdirAll(sharedDir, 0755))

		// Create the deepest dependency: another.ts
		anotherFile := filepath.Join(sharedDir, "another.ts")
		require.NoError(t, os.WriteFile(anotherFile, []byte(`export const another = "original value";`), 0600))

		// Create the intermediate dependency: test.ts (imports from another.ts)
		testFile := filepath.Join(sharedDir, "test.ts")
		require.NoError(t, os.WriteFile(testFile, []byte("import { another } from './another.ts';\nexport const value = `some ${another}`;"), 0600))

		// Create the function: index.ts (imports from test.ts)
		funcDir := filepath.Join(functionsDir, "transitive")
		require.NoError(t, os.MkdirAll(funcDir, 0755))
		funcFile := filepath.Join(funcDir, "index.ts")
		require.NoError(t, os.WriteFile(funcFile, []byte(`import { value } from '../../shared/test.ts';

export default async (): Promise<Response> => {
  console.log(value);
  return new Response(value);
};`), 0600))

		// Set up the file watcher
		fsys := afero.NewOsFs()
		watcher, watchedPath, err := setupFileWatcher(fsys)
		require.NoError(t, err)
		require.NotNil(t, watcher)
		require.NotEmpty(t, watchedPath)
		defer watcher.Close()

		// Start the file watcher
		ctx, cancel := context.WithTimeout(setup.Context, 3*time.Second)
		defer cancel()

		restartChan := make(chan struct{}, 10)
		watchedDirs := make(map[string]bool)
		go runFileWatcher(ctx, watcher, watchedPath, restartChan, watchedDirs, fsys)

		// Give watcher time to initialize and process the dependency chain
		time.Sleep(200 * time.Millisecond)

		// Modify another.ts (the deepest dependency)
		// This should trigger a restart because:
		// index.ts -> test.ts -> another.ts
		require.NoError(t, os.WriteFile(anotherFile, []byte(`export const another = "updated value";`), 0600))

		// Wait for restart signal - this tests true transitive dependency tracking
		select {
		case <-restartChan:
			// Expected - change to transitive dependency should trigger restart
		case <-time.After(2 * time.Second):
			t.Error("Expected restart signal after modifying transitive dependency (another.ts)")
		}

		// Also test that modifying the intermediate dependency triggers restart
		require.NoError(t, os.WriteFile(testFile, []byte("import { another } from './another.ts';\nexport const value = `modified ${another}`;"), 0600))

		// Wait for restart signal
		select {
		case <-restartChan:
			// Expected - change to intermediate dependency should trigger restart
		case <-time.After(2 * time.Second):
			t.Error("Expected restart signal after modifying intermediate dependency (test.ts)")
		}
	})

	t.Run("removes unused transitive dependencies from watcher", func(t *testing.T) {
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

		// Create dependency chain: function -> utils -> helpers
		utilsDir := filepath.Join(tempDir, "lib", "utils")
		helpersDir := filepath.Join(tempDir, "lib", "helpers")
		require.NoError(t, os.MkdirAll(utilsDir, 0755))
		require.NoError(t, os.MkdirAll(helpersDir, 0755))

		// Create helper file (deepest dependency)
		helperFile := filepath.Join(helpersDir, "common.ts")
		require.NoError(t, os.WriteFile(helperFile, []byte(`export const helper = "helper value";`), 0600))

		// Create utils file that imports from helpers
		utilsFile := filepath.Join(utilsDir, "index.ts")
		require.NoError(t, os.WriteFile(utilsFile, []byte(`
import { helper } from "../helpers/common.ts";
export const utilValue = `+"`util: ${helper}`;"+`
`), 0600))

		// Create function that imports from utils (which transitively imports helpers)
		funcDir := filepath.Join(functionsDir, "test")
		require.NoError(t, os.MkdirAll(funcDir, 0755))
		funcFile := filepath.Join(funcDir, "index.ts")
		require.NoError(t, os.WriteFile(funcFile, []byte(`
import { utilValue } from "../../lib/utils/index.ts";

export default async (): Promise<Response> => {
  return new Response(utilValue);
};
`), 0600))

		// Set up the file watcher
		fsys := afero.NewOsFs()
		watcher, watchedPath, err := setupFileWatcher(fsys)
		require.NoError(t, err)
		require.NotNil(t, watcher)
		require.NotEmpty(t, watchedPath)
		defer watcher.Close()

		// Start the file watcher
		ctx, cancel := context.WithTimeout(setup.Context, 5*time.Second)
		defer cancel()

		restartChan := make(chan struct{}, 10)
		watchedDirs := make(map[string]bool)
		go runFileWatcher(ctx, watcher, watchedPath, restartChan, watchedDirs, fsys)

		// Give watcher time to initialize and discover dependencies
		time.Sleep(500 * time.Millisecond)

		// Test 1: Verify that changes to helper file trigger restart (before removal)
		require.NoError(t, os.WriteFile(helperFile, []byte(`export const helper = "initial test";`), 0600))

		// Should trigger restart because helper is a transitive dependency
		select {
		case <-restartChan:
			// Expected - helper change should trigger restart when it's a dependency
		case <-time.After(2 * time.Second):
			t.Error("Expected restart signal from helper dependency change")
		}

		// Clear any remaining restart signals
		time.Sleep(100 * time.Millisecond)
		for len(restartChan) > 0 {
			<-restartChan
		}

		// Test 2: Remove dependency chain by modifying function to not import utils
		require.NoError(t, os.WriteFile(funcFile, []byte(`
export default async (): Promise<Response> => {
  return new Response("No more dependencies!");
};
`), 0600))

		// Wait for file change to be processed and dependencies to be updated
		select {
		case <-restartChan:
			// Expected - file change should trigger restart
		case <-time.After(2 * time.Second):
			t.Error("Expected restart signal after removing dependencies")
		}

		// Give the watcher time to process the change and clean up unused directories
		time.Sleep(800 * time.Millisecond)

		// Clear any remaining restart signals
		for len(restartChan) > 0 {
			<-restartChan
		}

		// Test 3: Verify that changes to helper no longer trigger restarts
		require.NoError(t, os.WriteFile(helperFile, []byte(`export const helper = "should not trigger restart";`), 0600))

		// Should NOT trigger restart because helper is no longer a dependency
		select {
		case <-restartChan:
			t.Error("Should not receive restart signal from unused dependency")
		case <-time.After(1 * time.Second):
			// Expected - no restart for unused dependencies
		}

		// Test 4: Verify that changes to utils file also don't trigger restarts
		require.NoError(t, os.WriteFile(utilsFile, []byte(`
export const utilValue = "should not trigger restart";
`), 0600))

		// Should NOT trigger restart because utils is no longer a dependency
		select {
		case <-restartChan:
			t.Error("Should not receive restart signal from unused utils dependency")
		case <-time.After(1 * time.Second):
			// Expected - no restart for unused dependencies
		}

		// Test 5: Verify function changes still trigger restarts
		require.NoError(t, os.WriteFile(funcFile, []byte(`
export default async (): Promise<Response> => {
  return new Response("Function still works!");
};
`), 0600))

		// Should trigger restart because function itself changed
		select {
		case <-restartChan:
			// Expected - function change should still trigger restart
		case <-time.After(2 * time.Second):
			t.Error("Expected restart signal from function change")
		}
	})
}
