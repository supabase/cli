package credentials

import (
	"testing"

	"github.com/go-errors/errors"
	"github.com/stretchr/testify/assert"
	"github.com/zalando/go-keyring"
)

func TestKeyringStore(t *testing.T) {
	t.Run("stores and retrieves password", func(t *testing.T) {
		keyring.MockInit()
		project := "test-project"
		password := "test-password"

		err := StoreProvider.Set(project, password)
		assert.NoError(t, err)

		retrieved, err := StoreProvider.Get(project)
		assert.NoError(t, err)
		assert.Equal(t, password, retrieved)
	})

	t.Run("returns error for non-existent project", func(t *testing.T) {
		keyring.MockInit()
		project := "non-existent"

		retrieved, err := StoreProvider.Get(project)
		assert.ErrorIs(t, err, keyring.ErrNotFound)
		assert.Empty(t, retrieved)
	})

	t.Run("deletes specific project password", func(t *testing.T) {
		keyring.MockInit()
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
		keyring.MockInit()
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

func TestKeyringErrors(t *testing.T) {
	t.Run("handles Get error", func(t *testing.T) {
		mockErr := errors.New("mock error")
		keyring.MockInitWithError(mockErr)

		_, err := StoreProvider.Get("test")
		assert.ErrorIs(t, err, mockErr)
	})

	t.Run("handles Set error", func(t *testing.T) {
		mockErr := errors.New("mock error")
		keyring.MockInitWithError(mockErr)

		err := StoreProvider.Set("test", "pass")
		assert.ErrorIs(t, err, mockErr)
	})

	t.Run("handles Delete error", func(t *testing.T) {
		mockErr := errors.New("mock error")
		keyring.MockInitWithError(mockErr)

		err := StoreProvider.Delete("test")
		assert.ErrorIs(t, err, mockErr)
	})

	t.Run("handles DeleteAll error", func(t *testing.T) {
		mockErr := errors.New("mock error")
		keyring.MockInitWithError(mockErr)

		err := StoreProvider.DeleteAll()
		assert.ErrorIs(t, err, mockErr)
	})
}
