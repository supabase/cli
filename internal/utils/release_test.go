package utils

import (
	"context"
	"net/http"
	"testing"

	"github.com/go-errors/errors"
	"github.com/google/go-github/v62/github"
	"github.com/h2non/gock"
	"github.com/stretchr/testify/assert"
	"github.com/supabase/cli/internal/testing/apitest"
	"github.com/supabase/cli/pkg/cast"
)

func TestLatestRelease(t *testing.T) {
	t.Run("fetches latest release", func(t *testing.T) {
		// Setup api mock
		defer gock.OffAll()
		gock.New("https://api.github.com").
			Get("/repos/supabase/cli/releases/latest").
			Reply(http.StatusOK).
			JSON(github.RepositoryRelease{TagName: cast.Ptr("v2")})
		// Run test
		version, err := GetLatestRelease(context.Background())
		// Check error
		assert.NoError(t, err)
		assert.Equal(t, version, "v2")
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})

	t.Run("ignores missing version", func(t *testing.T) {
		// Setup api mock
		defer gock.OffAll()
		gock.New("https://api.github.com").
			Get("/repos/supabase/cli/releases/latest").
			Reply(http.StatusOK).
			JSON(github.RepositoryRelease{})
		// Run test
		version, err := GetLatestRelease(context.Background())
		// Check error
		assert.NoError(t, err)
		assert.Empty(t, version)
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})

	t.Run("throws error on network error", func(t *testing.T) {
		errNetwork := errors.New("network error")
		// Setup api mock
		defer gock.OffAll()
		gock.New("https://api.github.com").
			Get("/repos/supabase/cli/releases/latest").
			ReplyError(errNetwork)
		// Run test
		version, err := GetLatestRelease(context.Background())
		// Check error
		assert.ErrorIs(t, err, errNetwork)
		assert.Empty(t, version)
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})
}
