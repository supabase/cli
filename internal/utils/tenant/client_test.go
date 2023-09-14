package tenant

import (
	"context"
	"net/http"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/supabase/cli/internal/utils"
	"gopkg.in/h2non/gock.v1"
)

func TestGetJSON(t *testing.T) {
	t.Run("throws error on invalid url", func(t *testing.T) {
		// Run test
		data, err := GetJsonResponse[string](context.Background(), "http://h:p", "")
		// Check error
		assert.ErrorContains(t, err, "invalid port")
		assert.Empty(t, data)
	})

	t.Run("throws error on server unavailable", func(t *testing.T) {
		// Setup mock api
		defer gock.OffAll()
		gock.New(utils.DefaultApiHost).
			Get("/").
			Reply(http.StatusServiceUnavailable)
		// Run test
		data, err := GetJsonResponse[string](context.Background(), utils.DefaultApiHost, "")
		// Check error
		assert.ErrorContains(t, err, "Error status 503")
		assert.Empty(t, data)
	})

	t.Run("throws error on malformed json", func(t *testing.T) {
		// Setup mock api
		defer gock.OffAll()
		gock.New(utils.DefaultApiHost).
			Get("/").
			Reply(http.StatusOK).
			JSON("malformed")
		// Run test
		data, err := GetJsonResponse[string](context.Background(), utils.DefaultApiHost, "")
		// Check error
		assert.ErrorContains(t, err, "invalid character")
		assert.Empty(t, data)
	})
}
