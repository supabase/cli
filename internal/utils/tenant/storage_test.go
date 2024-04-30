package tenant

import (
	"context"
	"errors"
	"net/http"
	"testing"

	"github.com/stretchr/testify/assert"
	"gopkg.in/h2non/gock.v1"
)

func TestStorageVersion(t *testing.T) {
	t.Run("appends prefix v", func(t *testing.T) {
		// Setup mock api
		defer gock.OffAll()
		gock.New("http://127.0.0.1").
			Get("/storage/v1/version").
			Reply(http.StatusOK).
			BodyString("0.40.4")
		// Run test
		version, err := GetStorageVersion(context.Background(), mockApi)
		// Check error
		assert.NoError(t, err)
		assert.Equal(t, "v0.40.4", version)
	})

	t.Run("throws error on network error", func(t *testing.T) {
		// Setup mock api
		defer gock.OffAll()
		gock.New("http://127.0.0.1").
			Get("/storage/v1/version").
			ReplyError(errors.New("network error"))
		// Run test
		version, err := GetStorageVersion(context.Background(), mockApi)
		// Check error
		assert.ErrorContains(t, err, "network error")
		assert.Empty(t, version)
	})

	t.Run("throws error on missing version", func(t *testing.T) {
		// Setup mock api
		defer gock.OffAll()
		gock.New("http://127.0.0.1").
			Get("/storage/v1/version").
			Reply(http.StatusOK).
			BodyString("0.0.0")
		// Run test
		version, err := GetStorageVersion(context.Background(), mockApi)
		// Check error
		assert.ErrorIs(t, err, errStorageVersion)
		assert.Empty(t, version)
	})
}
