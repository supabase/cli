package update

import (
	"context"
	"errors"
	"net/http"
	"testing"

	"github.com/h2non/gock"
	"github.com/stretchr/testify/assert"
	"github.com/supabase/cli/internal/testing/apitest"
	"github.com/supabase/cli/internal/utils"
)

func TestValidateIP(t *testing.T) {
	t.Run("accepts private subnet", func(t *testing.T) {
		err := validateIps([]string{"12.3.4.5", "10.0.0.0", "1.2.3.1"})
		assert.NoError(t, err)
	})

	t.Run("accepts IPv6 address", func(t *testing.T) {
		err := validateIps([]string{"2001:db8:abcd:0012::0", "::0"})
		assert.NoError(t, err)
	})

	t.Run("throws error on invalid IP", func(t *testing.T) {
		// Run test
		err := Run(context.Background(), "test-project", []string{"12.3.4"}, nil)
		// Check error
		assert.ErrorContains(t, err, "invalid IP address: 12.3.4")
	})
}

func TestRemoveBans(t *testing.T) {
	// Setup valid access token
	token := apitest.RandomAccessToken(t)
	t.Setenv("SUPABASE_ACCESS_TOKEN", string(token))

	t.Run("removes network bans", func(t *testing.T) {
		// Setup mock api
		defer gock.OffAll()
		gock.New(utils.DefaultApiHost).
			Delete("/v1/projects/test-project/network-bans").
			Reply(http.StatusOK)
		// Run test
		err := Run(context.Background(), "test-project", []string{}, nil)
		// Check error
		assert.NoError(t, err)
	})

	t.Run("throws error on network failure", func(t *testing.T) {
		errNetwork := errors.New("network error")
		// Setup mock api
		defer gock.OffAll()
		gock.New(utils.DefaultApiHost).
			Delete("/v1/projects/test-project/network-bans").
			ReplyError(errNetwork)
		// Run test
		err := Run(context.Background(), "test-project", []string{}, nil)
		// Check error
		assert.ErrorIs(t, err, errNetwork)
	})

	t.Run("throws error on service unavailable", func(t *testing.T) {
		// Setup mock api
		defer gock.OffAll()
		gock.New(utils.DefaultApiHost).
			Delete("/v1/projects/test-project/network-bans").
			Reply(http.StatusServiceUnavailable)
		// Run test
		err := Run(context.Background(), "test-project", []string{}, nil)
		// Check error
		assert.ErrorContains(t, err, "unexpected unban status 503:")
	})
}
