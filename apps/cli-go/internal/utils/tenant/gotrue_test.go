package tenant

import (
	"context"
	"errors"
	"net/http"
	"testing"

	"github.com/h2non/gock"
	"github.com/stretchr/testify/assert"
	"github.com/supabase/cli/pkg/fetcher"
)

var mockApi = TenantAPI{Fetcher: fetcher.NewFetcher(
	"http://127.0.0.1",
)}

func TestGotrueVersion(t *testing.T) {
	t.Run("gets gotrue version", func(t *testing.T) {
		// Setup mock api
		defer gock.OffAll()
		gock.New("http://127.0.0.1").
			Get("/auth/v1/health").
			Reply(http.StatusOK).
			JSON(HealthResponse{Version: "v2.92.1"})
		// Run test
		version, err := mockApi.GetGotrueVersion(context.Background())
		// Check error
		assert.NoError(t, err)
		assert.Equal(t, "v2.92.1", version)
	})

	t.Run("throws error on network error", func(t *testing.T) {
		// Setup mock api
		defer gock.OffAll()
		gock.New("http://127.0.0.1").
			Get("/auth/v1/health").
			ReplyError(errors.New("network error"))
		// Run test
		version, err := mockApi.GetGotrueVersion(context.Background())
		// Check error
		assert.ErrorContains(t, err, "network error")
		assert.Empty(t, version)
	})

	t.Run("throws error on missing version", func(t *testing.T) {
		// Setup mock api
		defer gock.OffAll()
		gock.New("http://127.0.0.1").
			Get("/auth/v1/health").
			Reply(http.StatusOK).
			JSON(HealthResponse{})
		// Run test
		version, err := mockApi.GetGotrueVersion(context.Background())
		// Check error
		assert.ErrorIs(t, err, errGotrueVersion)
		assert.Empty(t, version)
	})
}
