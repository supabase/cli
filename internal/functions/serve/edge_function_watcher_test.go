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
	"github.com/supabase/cli/internal/utils"
)

func TestNewEdgeFunctionWatcher(t *testing.T) {
	fsys := afero.NewMemMapFs()
	watcher, err := NewEdgeFunctionWatcher(fsys)
	require.NoError(t, err)
	require.NotNil(t, watcher)
	defer watcher.Close()

	assert.NotNil(t, watcher.genericWatcher)
	assert.Equal(t, fsys, watcher.fsys)
}

func TestIsIgnoredEdgeFunctionDir(t *testing.T) {
	rootPath := "/home/project/supabase/functions"

	testCases := []struct {
		name        string
		dirName     string
		currentPath string
		expected    bool
	}{
		{"never ignores root directory", "functions", rootPath, false},
		{"ignores git directory", ".git", filepath.Join(rootPath, ".git"), true},
		{"ignores node_modules", "node_modules", filepath.Join(rootPath, "node_modules"), true},
		{"ignores vscode directory", ".vscode", filepath.Join(rootPath, ".vscode"), true},
		{"allows normal directories", "src", filepath.Join(rootPath, "src"), false},
		{"allows function directories", "my-function", filepath.Join(rootPath, "my-function"), false},
		{"ignores dot directories", ".cache", filepath.Join(rootPath, ".cache"), true},
	}

	for _, tc := range testCases {
		t.Run(tc.name, func(t *testing.T) {
			result := isIgnoredEdgeFunctionDir(tc.dirName, rootPath, tc.currentPath)
			assert.Equal(t, tc.expected, result)
		})
	}
}

func TestIsIgnoredEdgeFunctionFileEvent(t *testing.T) {
	testCases := []struct {
		name     string
		filename string
		op       fsnotify.Op
		expected bool
	}{
		// Regular files that should not be ignored
		{"TypeScript file", "index.ts", fsnotify.Write, false},
		{"JavaScript file", "function.js", fsnotify.Create, false},
		{"JSON config", "config.json", fsnotify.Write, false},
		{"TOML config", "config.toml", fsnotify.Write, false},

		// Editor files that should be ignored
		{"Vim backup", "file.txt~", fsnotify.Write, true},
		{"Vim swap", ".file.swp", fsnotify.Create, true},
		{"Emacs lock", ".#file.txt", fsnotify.Create, true},
		{"Temp file", "file.tmp", fsnotify.Write, true},

		// Deno temporary files
		{"Deno bundle", "___deno_bundle_123___", fsnotify.Create, true},
		{"Deno temp", "___temp_file___", fsnotify.Write, true},

		// Special operation cases
		{"CHMOD on underscore file", "file___", fsnotify.Chmod, true},
		{"Write on underscore file", "file___", fsnotify.Write, false},
	}

	for _, tc := range testCases {
		t.Run(tc.name, func(t *testing.T) {
			result := isIgnoredEdgeFunctionFileEvent(tc.filename, tc.op)
			assert.Equal(t, tc.expected, result)
		})
	}
}

func TestEdgeFunctionWatcher_UpdateWatchTargets(t *testing.T) {
	t.Run("watches functions directory when it exists", func(t *testing.T) {
		tempDir := t.TempDir()
		functionsDir := filepath.Join(tempDir, "functions")
		require.NoError(t, os.MkdirAll(functionsDir, 0755))

		// Create a test function
		testFunc := filepath.Join(functionsDir, "hello", "index.ts")
		require.NoError(t, os.MkdirAll(filepath.Dir(testFunc), 0755))
		require.NoError(t, os.WriteFile(testFunc, []byte("export default () => new Response('hello')"), 0644))

		// Temporarily set utils.FunctionsDir
		originalFunctionsDir := utils.FunctionsDir
		utils.FunctionsDir = functionsDir
		defer func() { utils.FunctionsDir = originalFunctionsDir }()

		fsys := afero.NewOsFs()
		watcher, err := NewEdgeFunctionWatcher(fsys)
		require.NoError(t, err)
		defer watcher.Close()

		err = watcher.UpdateWatchTargets()
		assert.NoError(t, err)

		// Should have the functions directory as a target
		found := false
		for _, target := range watcher.genericWatcher.watchTargets {
			if target.Path == functionsDir && !target.IsFile {
				found = true
				break
			}
		}
		assert.True(t, found, "functions directory should be in watch targets")
	})

	t.Run("watches config.toml file when it exists", func(t *testing.T) {
		tempDir := t.TempDir()
		configFile := filepath.Join(tempDir, "config.toml")
		require.NoError(t, os.WriteFile(configFile, []byte("[api]\nport = 54321"), 0644))

		// Temporarily set utils.ConfigPath
		originalConfigPath := utils.ConfigPath
		utils.ConfigPath = configFile
		defer func() { utils.ConfigPath = originalConfigPath }()

		fsys := afero.NewOsFs()
		watcher, err := NewEdgeFunctionWatcher(fsys)
		require.NoError(t, err)
		defer watcher.Close()

		err = watcher.UpdateWatchTargets()
		assert.NoError(t, err)

		// Should have the config file as a target
		found := false
		for _, target := range watcher.genericWatcher.watchTargets {
			if target.Path == configFile && target.IsFile {
				found = true
				break
			}
		}
		assert.True(t, found, "config.toml file should be in watch targets")
	})

	t.Run("handles missing directories gracefully", func(t *testing.T) {
		tempDir := t.TempDir()
		nonExistentDir := filepath.Join(tempDir, "nonexistent")

		// Set paths to non-existent locations
		originalFunctionsDir := utils.FunctionsDir
		originalConfigPath := utils.ConfigPath
		utils.FunctionsDir = nonExistentDir
		utils.ConfigPath = filepath.Join(nonExistentDir, "config.toml")
		defer func() {
			utils.FunctionsDir = originalFunctionsDir
			utils.ConfigPath = originalConfigPath
		}()

		fsys := afero.NewOsFs()
		watcher, err := NewEdgeFunctionWatcher(fsys)
		require.NoError(t, err)
		defer watcher.Close()

		err = watcher.UpdateWatchTargets()
		assert.NoError(t, err)

		// Should have no targets since directories don't exist
		assert.Empty(t, watcher.genericWatcher.watchTargets)
	})
}

func TestEdgeFunctionWatcher_Watch_FunctionsDirectory(t *testing.T) {
	tempDir := t.TempDir()
	functionsDir := filepath.Join(tempDir, "functions")
	require.NoError(t, os.MkdirAll(functionsDir, 0755))

	// Temporarily set utils.FunctionsDir
	originalFunctionsDir := utils.FunctionsDir
	utils.FunctionsDir = functionsDir
	defer func() { utils.FunctionsDir = originalFunctionsDir }()

	fsys := afero.NewOsFs()
	watcher, err := NewEdgeFunctionWatcher(fsys)
	require.NoError(t, err)
	defer watcher.Close()

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	restartChan, errorChan := watcher.Watch(ctx)

	// Create a new function file
	testFunc := filepath.Join(functionsDir, "test", "index.ts")
	require.NoError(t, os.MkdirAll(filepath.Dir(testFunc), 0755))
	require.NoError(t, os.WriteFile(testFunc, []byte("export default () => new Response('test')"), 0644))

	// Should receive a restart signal
	select {
	case <-restartChan:
		// Success
	case err := <-errorChan:
		t.Fatalf("unexpected error: %v", err)
	case <-time.After(1 * time.Second):
		t.Fatal("expected restart signal but didn't receive one")
	}
}

func TestEdgeFunctionWatcher_Watch_ConfigFile(t *testing.T) {
	tempDir := t.TempDir()
	configFile := filepath.Join(tempDir, "config.toml")
	require.NoError(t, os.WriteFile(configFile, []byte("[api]\nport = 54321"), 0644))

	// Temporarily set utils.ConfigPath
	originalConfigPath := utils.ConfigPath
	utils.ConfigPath = configFile
	defer func() { utils.ConfigPath = originalConfigPath }()

	fsys := afero.NewOsFs()
	watcher, err := NewEdgeFunctionWatcher(fsys)
	require.NoError(t, err)
	defer watcher.Close()

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	restartChan, errorChan := watcher.Watch(ctx)

	// Modify the config file
	require.NoError(t, os.WriteFile(configFile, []byte("[api]\nport = 55555"), 0644))

	// Should receive a restart signal
	select {
	case <-restartChan:
		// Success
	case err := <-errorChan:
		t.Fatalf("unexpected error: %v", err)
	case <-time.After(1 * time.Second):
		t.Fatal("expected restart signal but didn't receive one")
	}
}

func TestEdgeFunctionWatcher_Watch_IgnoredFiles(t *testing.T) {
	tempDir := t.TempDir()
	functionsDir := filepath.Join(tempDir, "functions")
	require.NoError(t, os.MkdirAll(functionsDir, 0755))

	// Temporarily set utils.FunctionsDir
	originalFunctionsDir := utils.FunctionsDir
	utils.FunctionsDir = functionsDir
	defer func() { utils.FunctionsDir = originalFunctionsDir }()

	fsys := afero.NewOsFs()
	watcher, err := NewEdgeFunctionWatcher(fsys)
	require.NoError(t, err)
	defer watcher.Close()

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	restartChan, errorChan := watcher.Watch(ctx)

	// Create an ignored file (should not trigger restart)
	ignoredFile := filepath.Join(functionsDir, "test.tmp")
	require.NoError(t, os.WriteFile(ignoredFile, []byte("ignored"), 0644))

	// Should NOT receive a restart signal
	select {
	case <-restartChan:
		t.Fatal("unexpected restart signal for ignored file")
	case err := <-errorChan:
		t.Fatalf("unexpected error: %v", err)
	case <-time.After(200 * time.Millisecond):
		// Success - no signal received
	}

	// Now create a normal file (should trigger restart)
	normalFile := filepath.Join(functionsDir, "test.ts")
	require.NoError(t, os.WriteFile(normalFile, []byte("export default () => new Response('test')"), 0644))

	select {
	case <-restartChan:
		// Success
	case err := <-errorChan:
		t.Fatalf("unexpected error: %v", err)
	case <-time.After(1 * time.Second):
		t.Fatal("expected restart signal but didn't receive one")
	}
}

func TestEdgeFunctionWatcher_Close(t *testing.T) {
	fsys := afero.NewMemMapFs()
	watcher, err := NewEdgeFunctionWatcher(fsys)
	require.NoError(t, err)

	err = watcher.Close()
	assert.NoError(t, err)

	// Closing again should not cause an error
	err = watcher.Close()
	assert.NoError(t, err)
}
func TestEdgeFunctionWatcher_Integration_IgnoreNonValidFiles(t *testing.T) {
	tempDir := t.TempDir()
	functionsDir := filepath.Join(tempDir, "functions")
	require.NoError(t, os.MkdirAll(functionsDir, 0755))

	// Temporarily set utils.FunctionsDir
	originalFunctionsDir := utils.FunctionsDir
	utils.FunctionsDir = functionsDir
	defer func() { utils.FunctionsDir = originalFunctionsDir }()

	// Create function directory
	funcDir := filepath.Join(functionsDir, "test")
	require.NoError(t, os.MkdirAll(funcDir, 0755))

	fsys := afero.NewOsFs()
	watcher, err := NewEdgeFunctionWatcher(fsys)
	require.NoError(t, err)
	defer watcher.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()

	restartChan, errorChan := watcher.Watch(ctx)

	// Give watcher time to initialize
	time.Sleep(100 * time.Millisecond)

	// Create and modify files that should not trigger reloads
	ignoredFiles := []string{
		filepath.Join(funcDir, "test.tmp"),        // temp file
		filepath.Join(funcDir, ".test.swp"),       // vim swap
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
	case err := <-errorChan:
		t.Fatalf("unexpected error: %v", err)
	case <-time.After(100 * time.Millisecond):
		// Expected - no restart for ignored files
	}
}

func TestEdgeFunctionWatcher_Integration_TransitiveDependencies(t *testing.T) {
	tempDir := t.TempDir()
	functionsDir := filepath.Join(tempDir, "functions")
	require.NoError(t, os.MkdirAll(functionsDir, 0755))

	// Temporarily set utils.FunctionsDir
	originalFunctionsDir := utils.FunctionsDir
	utils.FunctionsDir = functionsDir
	defer func() { utils.FunctionsDir = originalFunctionsDir }()

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

	fsys := afero.NewOsFs()
	watcher, err := NewEdgeFunctionWatcher(fsys)
	require.NoError(t, err)
	defer watcher.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()

	restartChan, errorChan := watcher.Watch(ctx)

	// Give watcher time to initialize and process the dependency chain
	time.Sleep(200 * time.Millisecond)

	// Modify another.ts (the deepest dependency)
	require.NoError(t, os.WriteFile(anotherFile, []byte(`export const another = "updated value";`), 0600))

	// Wait for restart signal - this tests true transitive dependency tracking
	select {
	case <-restartChan:
		// Expected - change to transitive dependency should trigger restart
	case err := <-errorChan:
		t.Fatalf("unexpected error: %v", err)
	case <-time.After(2 * time.Second):
		t.Error("Expected restart signal after modifying transitive dependency (another.ts)")
	}
}

func TestEdgeFunctionWatcher_Integration_FunctionLifecycle(t *testing.T) {
	tempDir := t.TempDir()
	functionsDir := filepath.Join(tempDir, "functions")
	require.NoError(t, os.MkdirAll(functionsDir, 0755))

	// Temporarily set utils.FunctionsDir
	originalFunctionsDir := utils.FunctionsDir
	utils.FunctionsDir = functionsDir
	defer func() { utils.FunctionsDir = originalFunctionsDir }()

	fsys := afero.NewOsFs()
	watcher, err := NewEdgeFunctionWatcher(fsys)
	require.NoError(t, err)
	defer watcher.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()

	restartChan, errorChan := watcher.Watch(ctx)

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
	case err := <-errorChan:
		t.Fatalf("unexpected error: %v", err)
	case <-time.After(1 * time.Second):
		t.Error("Expected restart signal after adding new function")
	}

	// Test 2: Update existing function
	require.NoError(t, os.WriteFile(newFuncFile, []byte("export default () => new Response('updated')"), 0600))

	// Wait for restart signal
	select {
	case <-restartChan:
		// Expected - update should trigger restart
	case err := <-errorChan:
		t.Fatalf("unexpected error: %v", err)
	case <-time.After(1 * time.Second):
		t.Error("Expected restart signal after updating function")
	}

	// Test 3: Remove function
	require.NoError(t, os.RemoveAll(newFuncDir))

	// Wait for restart signal
	select {
	case <-restartChan:
		// Expected - removal should trigger restart
	case err := <-errorChan:
		t.Fatalf("unexpected error: %v", err)
	case <-time.After(1 * time.Second):
		t.Error("Expected restart signal after removing function")
	}
}

func TestEdgeFunctionWatcher_Integration_ComplexMultiLevelDependencies(t *testing.T) {
	tempDir := t.TempDir()
	functionsDir := filepath.Join(tempDir, "functions")
	require.NoError(t, os.MkdirAll(functionsDir, 0755))

	// Temporarily set utils.FunctionsDir
	originalFunctionsDir := utils.FunctionsDir
	utils.FunctionsDir = functionsDir
	defer func() { utils.FunctionsDir = originalFunctionsDir }()

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

	fsys := afero.NewOsFs()
	watcher, err := NewEdgeFunctionWatcher(fsys)
	require.NoError(t, err)
	defer watcher.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()

	restartChan, errorChan := watcher.Watch(ctx)

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
	case err := <-errorChan:
		t.Fatalf("unexpected error: %v", err)
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
	case err := <-errorChan:
		t.Fatalf("unexpected error: %v", err)
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
	case err := <-errorChan:
		t.Fatalf("unexpected error: %v", err)
	case <-time.After(1 * time.Second):
		t.Error("Expected restart signal after modifying database file")
	}
}

func TestEdgeFunctionWatcher_Integration_WatcherErrorHandling(t *testing.T) {
	tempDir := t.TempDir()
	functionsDir := filepath.Join(tempDir, "functions")
	require.NoError(t, os.MkdirAll(functionsDir, 0755))

	// Temporarily set utils.FunctionsDir
	originalFunctionsDir := utils.FunctionsDir
	utils.FunctionsDir = functionsDir
	defer func() { utils.FunctionsDir = originalFunctionsDir }()

	// Create a function with invalid imports
	funcDir := filepath.Join(functionsDir, "test")
	require.NoError(t, os.MkdirAll(funcDir, 0755))
	funcFile := filepath.Join(funcDir, "index.ts")
	require.NoError(t, os.WriteFile(funcFile, []byte(`
import { something } from "/invalid/path";
export default () => new Response("test");
`), 0600))

	fsys := afero.NewOsFs()
	watcher, err := NewEdgeFunctionWatcher(fsys)
	require.NoError(t, err)
	defer watcher.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()

	restartChan, errorChan := watcher.Watch(ctx)

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
	case err := <-errorChan:
		t.Fatalf("unexpected error: %v", err)
	case <-time.After(1 * time.Second):
		t.Error("Expected restart signal after modifying function with invalid imports")
	}
}

func TestEdgeFunctionWatcher_Integration_DependencyRemoval(t *testing.T) {
	tempDir := t.TempDir()
	functionsDir := filepath.Join(tempDir, "functions")
	require.NoError(t, os.MkdirAll(functionsDir, 0755))

	// Temporarily set utils.FunctionsDir
	originalFunctionsDir := utils.FunctionsDir
	utils.FunctionsDir = functionsDir
	defer func() { utils.FunctionsDir = originalFunctionsDir }()

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

	fsys := afero.NewOsFs()
	watcher, err := NewEdgeFunctionWatcher(fsys)
	require.NoError(t, err)
	defer watcher.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	restartChan, errorChan := watcher.Watch(ctx)

	// Give watcher time to initialize and discover dependencies
	time.Sleep(500 * time.Millisecond)

	// Test 1: Verify that changes to helper file trigger restart (before removal)
	require.NoError(t, os.WriteFile(helperFile, []byte(`export const helper = "initial test";`), 0600))

	// Should trigger restart because helper is a transitive dependency
	select {
	case <-restartChan:
		// Expected - helper change should trigger restart when it's a dependency
	case err := <-errorChan:
		t.Fatalf("unexpected error: %v", err)
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
	case err := <-errorChan:
		t.Fatalf("unexpected error: %v", err)
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
	case err := <-errorChan:
		t.Fatalf("unexpected error: %v", err)
	case <-time.After(1 * time.Second):
		// Expected - no restart for unused dependencies
	}

	// Test 4: Verify function changes still trigger restarts
	require.NoError(t, os.WriteFile(funcFile, []byte(`
export default async (): Promise<Response> => {
  return new Response("Function still works!");
};
`), 0600))

	// Should trigger restart because function itself changed
	select {
	case <-restartChan:
		// Expected - function change should still trigger restart
	case err := <-errorChan:
		t.Fatalf("unexpected error: %v", err)
	case <-time.After(2 * time.Second):
		t.Error("Expected restart signal from function change")
	}
}
