package tenant

import (
	"context"
	"errors"
	"net/http"
	"testing"

	"github.com/h2non/gock"
	"github.com/stretchr/testify/assert"
)

func TestPostgrestVersion(t *testing.T) {
	t.Run("appends prefix v", func(t *testing.T) {
		// Setup mock api
		defer gock.OffAll()
		gock.New("http://127.0.0.1").
			Get("/rest/v1/").
			Reply(http.StatusOK).
			JSON(SwaggerResponse{Info: SwaggerInfo{Version: "11.1.0"}})
		// Run test
		version, err := mockApi.GetPostgrestVersion(context.Background())
		// Check error
		assert.NoError(t, err)
		assert.Equal(t, "v11.1.0", version)
	})

	t.Run("ignores commit hash", func(t *testing.T) {
		// Setup mock api
		defer gock.OffAll()
		gock.New("http://127.0.0.1").
			Get("/rest/v1/").
			Reply(http.StatusOK).
			JSON(SwaggerResponse{Info: SwaggerInfo{Version: "11.2.0 (c820efb)"}})
		// Run test
		version, err := mockApi.GetPostgrestVersion(context.Background())
		// Check error
		assert.NoError(t, err)
		assert.Equal(t, "v11.2.0", version)
	})

	t.Run("throws error on network error", func(t *testing.T) {
		// Setup mock api
		defer gock.OffAll()
		gock.New("http://127.0.0.1").
			Get("/rest/v1/").
			ReplyError(errors.New("network error"))
		// Run test
		version, err := mockApi.GetPostgrestVersion(context.Background())
		// Check error
		assert.ErrorContains(t, err, "network error")
		assert.Empty(t, version)
	})

	t.Run("throws error on missing version", func(t *testing.T) {
		// Setup mock api
		defer gock.OffAll()
		gock.New("http://127.0.0.1").
			Get("/rest/v1/").
			Reply(http.StatusOK).
			JSON(SwaggerResponse{})
		// Run test
		version, err := mockApi.GetPostgrestVersion(context.Background())
		// Check error
		assert.ErrorIs(t, err, errPostgrestVersion)
		assert.Empty(t, version)
	})
}
