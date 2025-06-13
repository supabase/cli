package serve

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/fsnotify/fsnotify"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestNewGenericFileWatcher(t *testing.T) {
	config := GenericFileWatcherConfig{
		DebounceDuration: 100 * time.Millisecond,
		IgnoreFunc:       nil,
		DirIgnoreFunc:    nil,
	}

	watcher, err := NewGenericFileWatcher(config)
	require.NoError(t, err)
	require.NotNil(t, watcher)
	defer watcher.Close()

	assert.Equal(t, config.DebounceDuration, watcher.debounceDuration)
	assert.NotNil(t, watcher.watcher)
	assert.NotNil(t, watcher.watchedPaths)
	assert.NotNil(t, watcher.restartChan)
	assert.NotNil(t, watcher.errorChan)
}

func TestGenericFileWatcher_SetWatchTargets(t *testing.T) {
	t.Run("can set directory targets", func(t *testing.T) {
		tempDir := t.TempDir()
		targetDir := filepath.Join(tempDir, "test")
		require.NoError(t, os.MkdirAll(targetDir, 0755))

		config := GenericFileWatcherConfig{
			DebounceDuration: 100 * time.Millisecond,
		}
		watcher, err := NewGenericFileWatcher(config)
		require.NoError(t, err)
		defer watcher.Close()

		targets := []WatchTarget{
			{Path: targetDir, IsFile: false},
		}

		err = watcher.SetWatchTargets(targets)
		assert.NoError(t, err)
		assert.True(t, watcher.watchedPaths[targetDir])
		assert.Equal(t, targets, watcher.watchTargets)
	})

	t.Run("can set file targets", func(t *testing.T) {
		tempDir := t.TempDir()
		targetFile := filepath.Join(tempDir, "test.txt")
		require.NoError(t, os.WriteFile(targetFile, []byte("test"), 0644))

		config := GenericFileWatcherConfig{
			DebounceDuration: 100 * time.Millisecond,
		}
		watcher, err := NewGenericFileWatcher(config)
		require.NoError(t, err)
		defer watcher.Close()

		targets := []WatchTarget{
			{Path: targetFile, IsFile: true},
		}

		err = watcher.SetWatchTargets(targets)
		assert.NoError(t, err)
		// For files, we watch the file itself directly
		assert.True(t, watcher.watchedPaths[targetFile])
		assert.Equal(t, targets, watcher.watchTargets)
	})

	t.Run("can replace existing targets", func(t *testing.T) {
		tempDir := t.TempDir()
		dir1 := filepath.Join(tempDir, "dir1")
		dir2 := filepath.Join(tempDir, "dir2")
		require.NoError(t, os.MkdirAll(dir1, 0755))
		require.NoError(t, os.MkdirAll(dir2, 0755))

		config := GenericFileWatcherConfig{
			DebounceDuration: 100 * time.Millisecond,
		}
		watcher, err := NewGenericFileWatcher(config)
		require.NoError(t, err)
		defer watcher.Close()

		// Set initial targets
		targets1 := []WatchTarget{
			{Path: dir1, IsFile: false},
		}
		err = watcher.SetWatchTargets(targets1)
		require.NoError(t, err)
		assert.True(t, watcher.watchedPaths[dir1])

		// Replace with new targets
		targets2 := []WatchTarget{
			{Path: dir2, IsFile: false},
		}
		err = watcher.SetWatchTargets(targets2)
		assert.NoError(t, err)
		assert.False(t, watcher.watchedPaths[dir1]) // Old target should be removed
		assert.True(t, watcher.watchedPaths[dir2])  // New target should be added
	})
}

func TestGenericFileWatcher_Watch_DirectoryEvents(t *testing.T) {
	tempDir := t.TempDir()
	testFile := filepath.Join(tempDir, "test.txt")

	config := GenericFileWatcherConfig{
		DebounceDuration: 50 * time.Millisecond,
	}
	watcher, err := NewGenericFileWatcher(config)
	require.NoError(t, err)
	defer watcher.Close()

	targets := []WatchTarget{
		{Path: tempDir, IsFile: false},
	}
	err = watcher.SetWatchTargets(targets)
	require.NoError(t, err)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	restartChan, errorChan := watcher.Watch(ctx)

	// Write to a file in the watched directory
	require.NoError(t, os.WriteFile(testFile, []byte("test content"), 0644))

	// Should receive a restart signal
	select {
	case <-restartChan:
		// Success
	case err := <-errorChan:
		t.Fatalf("unexpected error: %v", err)
	case <-time.After(200 * time.Millisecond):
		t.Fatal("expected restart signal but didn't receive one")
	}
}

func TestGenericFileWatcher_Watch_FileEvents(t *testing.T) {
	tempDir := t.TempDir()
	testFile := filepath.Join(tempDir, "config.toml")
	require.NoError(t, os.WriteFile(testFile, []byte("test = 'value'"), 0644))

	config := GenericFileWatcherConfig{
		DebounceDuration: 50 * time.Millisecond,
	}
	watcher, err := NewGenericFileWatcher(config)
	require.NoError(t, err)
	defer watcher.Close()

	targets := []WatchTarget{
		{Path: testFile, IsFile: true},
	}
	err = watcher.SetWatchTargets(targets)
	require.NoError(t, err)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	restartChan, errorChan := watcher.Watch(ctx)

	// Modify the specific file
	require.NoError(t, os.WriteFile(testFile, []byte("test = 'new_value'"), 0644))

	// Should receive a restart signal
	select {
	case <-restartChan:
		// Success
	case err := <-errorChan:
		t.Fatalf("unexpected error: %v", err)
	case <-time.After(200 * time.Millisecond):
		t.Fatal("expected restart signal but didn't receive one")
	}
}

func TestGenericFileWatcher_Watch_IgnoreSpecificFile(t *testing.T) {
	tempDir := t.TempDir()
	configFile := filepath.Join(tempDir, "config.toml")
	otherFile := filepath.Join(tempDir, "other.txt")
	require.NoError(t, os.WriteFile(configFile, []byte("test = 'value'"), 0644))
	require.NoError(t, os.WriteFile(otherFile, []byte("other content"), 0644))

	config := GenericFileWatcherConfig{
		DebounceDuration: 50 * time.Millisecond,
	}
	watcher, err := NewGenericFileWatcher(config)
	require.NoError(t, err)
	defer watcher.Close()

	// Only watch the config file specifically
	targets := []WatchTarget{
		{Path: configFile, IsFile: true},
	}
	err = watcher.SetWatchTargets(targets)
	require.NoError(t, err)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	restartChan, errorChan := watcher.Watch(ctx)

	// Modify the other file (should not trigger restart)
	require.NoError(t, os.WriteFile(otherFile, []byte("other content modified"), 0644))

	// Should NOT receive a restart signal
	select {
	case <-restartChan:
		t.Fatal("unexpected restart signal for file not being watched")
	case err := <-errorChan:
		t.Fatalf("unexpected error: %v", err)
	case <-time.After(100 * time.Millisecond):
		// Success - no signal received
	}

	// Now modify the watched file (should trigger restart)
	require.NoError(t, os.WriteFile(configFile, []byte("test = 'modified'"), 0644))

	select {
	case <-restartChan:
		// Success
	case err := <-errorChan:
		t.Fatalf("unexpected error: %v", err)
	case <-time.After(200 * time.Millisecond):
		t.Fatal("expected restart signal but didn't receive one")
	}
}

func TestGenericFileWatcher_Watch_WithIgnoreFunc(t *testing.T) {
	tempDir := t.TempDir()
	normalFile := filepath.Join(tempDir, "normal.txt")
	ignoreFile := filepath.Join(tempDir, "ignore.tmp")

	// Create ignore function that ignores .tmp files
	ignoreFunc := func(eventPath string, eventOp fsnotify.Op) bool {
		return filepath.Ext(eventPath) == ".tmp"
	}

	config := GenericFileWatcherConfig{
		DebounceDuration: 50 * time.Millisecond,
		IgnoreFunc:       ignoreFunc,
	}
	watcher, err := NewGenericFileWatcher(config)
	require.NoError(t, err)
	defer watcher.Close()

	targets := []WatchTarget{
		{Path: tempDir, IsFile: false},
	}
	err = watcher.SetWatchTargets(targets)
	require.NoError(t, err)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	restartChan, errorChan := watcher.Watch(ctx)

	// Create ignored file (should not trigger restart)
	require.NoError(t, os.WriteFile(ignoreFile, []byte("ignored"), 0644))

	select {
	case <-restartChan:
		t.Fatal("unexpected restart signal for ignored file")
	case err := <-errorChan:
		t.Fatalf("unexpected error: %v", err)
	case <-time.After(100 * time.Millisecond):
		// Success - no signal received
	}

	// Create normal file (should trigger restart)
	require.NoError(t, os.WriteFile(normalFile, []byte("normal"), 0644))

	select {
	case <-restartChan:
		// Success
	case err := <-errorChan:
		t.Fatalf("unexpected error: %v", err)
	case <-time.After(200 * time.Millisecond):
		t.Fatal("expected restart signal but didn't receive one")
	}
}

func TestGenericFileWatcher_Watch_Debouncing(t *testing.T) {
	tempDir := t.TempDir()
	testFile := filepath.Join(tempDir, "test.txt")

	config := GenericFileWatcherConfig{
		DebounceDuration: 100 * time.Millisecond,
	}
	watcher, err := NewGenericFileWatcher(config)
	require.NoError(t, err)
	defer watcher.Close()

	targets := []WatchTarget{
		{Path: tempDir, IsFile: false},
	}
	err = watcher.SetWatchTargets(targets)
	require.NoError(t, err)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	restartChan, errorChan := watcher.Watch(ctx)

	// Create multiple rapid changes
	for i := 0; i < 5; i++ {
		require.NoError(t, os.WriteFile(testFile, []byte("content"), 0644))
		time.Sleep(10 * time.Millisecond) // Rapid changes
	}

	// Should only receive one restart signal after debounce period
	restartCount := 0
	timeout := time.After(200 * time.Millisecond)

	for {
		select {
		case <-restartChan:
			restartCount++
		case err := <-errorChan:
			t.Fatalf("unexpected error: %v", err)
		case <-timeout:
			// Done counting
			goto done
		}
	}

done:
	// Should receive exactly one restart signal due to debouncing
	assert.Equal(t, 1, restartCount, "expected exactly one restart signal due to debouncing")
}

func TestGenericFileWatcher_Close(t *testing.T) {
	config := GenericFileWatcherConfig{
		DebounceDuration: 100 * time.Millisecond,
	}
	watcher, err := NewGenericFileWatcher(config)
	require.NoError(t, err)

	err = watcher.Close()
	assert.NoError(t, err)

	// Closing again should not cause an error
	err = watcher.Close()
	assert.NoError(t, err)
}
