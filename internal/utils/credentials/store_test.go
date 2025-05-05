package credentials

import (
	"os"
	"testing"

	"github.com/go-errors/errors"
	"github.com/stretchr/testify/assert"
	"github.com/zalando/go-keyring"
)

func TestKeyringStore(t *testing.T) {
	t.Run("stores and retrieves password", func(t *testing.T) {
		defer MockInit()()
		project := "test-project"
		password := "test-password"

		err := StoreProvider.Set(project, password)
		assert.NoError(t, err)

		retrieved, err := StoreProvider.Get(project)
		assert.NoError(t, err)
		assert.Equal(t, password, retrieved)
	})

	t.Run("returns error for non-existent project", func(t *testing.T) {
		defer MockInit()()
		project := "non-existent"

		retrieved, err := StoreProvider.Get(project)
		assert.ErrorIs(t, err, keyring.ErrNotFound)
		assert.Empty(t, retrieved)
	})

	t.Run("deletes specific project password", func(t *testing.T) {
		defer MockInit()()
		project := "test-project"
		password := "test-password"

		err := StoreProvider.Set(project, password)
		assert.NoError(t, err)
		err = StoreProvider.Delete(project)
		assert.NoError(t, err)

		_, err = StoreProvider.Get(project)
		assert.ErrorIs(t, err, keyring.ErrNotFound)
	})

	t.Run("deletes all project passwords", func(t *testing.T) {
		defer MockInit()()
		projects := []string{"project1", "project2"}

		for _, project := range projects {
			err := StoreProvider.Set(project, "password")
			assert.NoError(t, err)
		}

		err := StoreProvider.DeleteAll()
		assert.NoError(t, err)

		for _, project := range projects {
			_, err := StoreProvider.Get(project)
			assert.ErrorIs(t, err, keyring.ErrNotFound)
		}
	})
}

func setupWSLEnvironment(t *testing.T) func() {
	tmpFile, err := os.CreateTemp("", "osrelease")
	assert.NoError(t, err)

	_, err = tmpFile.WriteString("Linux version 5.10.16.3-microsoft-standard-WSL2")
	assert.NoError(t, err)

	oldProcPath := "/proc/sys/kernel/osrelease"
	if err := os.Rename(oldProcPath, oldProcPath+".bak"); err == nil {
		// Only setup symlink if we can backup original
		err = os.Symlink(tmpFile.Name(), oldProcPath)
		if err != nil {
			t.Skip("Cannot create symlink for testing WSL detection")
		}
	} else {
		t.Skip("Cannot backup original osrelease file")
	}

	return func() {
		os.Remove(tmpFile.Name())
		os.Remove(oldProcPath)
		os.Rename(oldProcPath+".bak", oldProcPath)
	}
}

func TestWSLSupport(t *testing.T) {
	t.Run("Get returns not supported in WSL", func(t *testing.T) {
		cleanup := setupWSLEnvironment(t)
		defer cleanup()

		store := &KeyringStore{}
		_, err := store.Get("test")
		assert.ErrorIs(t, err, ErrNotSupported)
	})

	t.Run("Set returns not supported in WSL", func(t *testing.T) {
		cleanup := setupWSLEnvironment(t)
		defer cleanup()

		store := &KeyringStore{}
		err := store.Set("test", "pass")
		assert.ErrorIs(t, err, ErrNotSupported)
	})

	t.Run("Delete returns not supported in WSL", func(t *testing.T) {
		cleanup := setupWSLEnvironment(t)
		defer cleanup()

		store := &KeyringStore{}
		err := store.Delete("test")
		assert.ErrorIs(t, err, ErrNotSupported)
	})

	t.Run("DeleteAll returns not supported in WSL", func(t *testing.T) {
		cleanup := setupWSLEnvironment(t)
		defer cleanup()

		store := &KeyringStore{}
		err := store.DeleteAll()
		assert.ErrorIs(t, err, ErrNotSupported)
	})
}

func TestKeyringErrors(t *testing.T) {
	t.Run("handles Get error", func(t *testing.T) {
		oldStore := StoreProvider
		defer func() { StoreProvider = oldStore }()
		mockErr := errors.New("mock error")
		StoreProvider = &mockProvider{mockError: mockErr}

		_, err := StoreProvider.Get("test")
		assert.ErrorIs(t, err, mockErr)
	})

	t.Run("handles Set error", func(t *testing.T) {
		oldStore := StoreProvider
		defer func() { StoreProvider = oldStore }()
		mockErr := errors.New("mock error")
		StoreProvider = &mockProvider{mockError: mockErr}

		err := StoreProvider.Set("test", "pass")
		assert.ErrorIs(t, err, mockErr)
	})

	t.Run("handles Delete error", func(t *testing.T) {
		oldStore := StoreProvider
		defer func() { StoreProvider = oldStore }()
		mockErr := errors.New("mock error")
		StoreProvider = &mockProvider{mockError: mockErr}

		err := StoreProvider.Delete("test")
		assert.ErrorIs(t, err, mockErr)
	})

	t.Run("handles DeleteAll error", func(t *testing.T) {
		oldStore := StoreProvider
		defer func() { StoreProvider = oldStore }()
		mockErr := errors.New("mock error")
		StoreProvider = &mockProvider{mockError: mockErr}

		err := StoreProvider.DeleteAll()
		assert.ErrorIs(t, err, mockErr)
	})
}
