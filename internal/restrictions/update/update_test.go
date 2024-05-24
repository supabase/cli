package update

import (
	"context"
	"net/http"
	"testing"

	"github.com/go-errors/errors"
	"github.com/h2non/gock"
	"github.com/stretchr/testify/assert"
	"github.com/supabase/cli/internal/testing/apitest"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/pkg/api"
)

func TestUpdateRestrictionsCommand(t *testing.T) {
	projectRef := apitest.RandomProjectRef()
	// Setup valid access token
	token := apitest.RandomAccessToken(t)
	t.Setenv("SUPABASE_ACCESS_TOKEN", string(token))

	t.Run("updates v4 and v6 CIDR", func(t *testing.T) {
		// Setup mock api
		defer gock.OffAll()
		gock.New(utils.DefaultApiHost).
			Post("/v1/projects/" + projectRef + "/network-restrictions/apply").
			MatchType("json").
			JSON(api.NetworkRestrictionsRequest{
				DbAllowedCidrs:   &[]string{"12.3.4.5/32", "1.2.3.1/24"},
				DbAllowedCidrsV6: &[]string{"2001:db8:abcd:0012::0/64"},
			}).
			Reply(http.StatusCreated).
			JSON(api.NetworkRestrictionsResponse{
				Status: api.NetworkRestrictionsResponseStatus("applied"),
			})
		// Run test
		err := Run(context.Background(), projectRef, []string{"12.3.4.5/32", "2001:db8:abcd:0012::0/64", "1.2.3.1/24"}, false)
		// Check error
		assert.NoError(t, err)
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})

	t.Run("throws error on network failure", func(t *testing.T) {
		errNetwork := errors.New("network error")
		// Setup mock api
		defer gock.OffAll()
		gock.New(utils.DefaultApiHost).
			Post("/v1/projects/" + projectRef + "/network-restrictions/apply").
			MatchType("json").
			JSON(api.NetworkRestrictionsRequest{
				DbAllowedCidrs:   &[]string{},
				DbAllowedCidrsV6: &[]string{},
			}).
			ReplyError(errNetwork)
		// Run test
		err := Run(context.Background(), projectRef, []string{}, true)
		// Check error
		assert.ErrorIs(t, err, errNetwork)
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})

	t.Run("throws error on server unavailable", func(t *testing.T) {
		// Setup mock api
		defer gock.OffAll()
		gock.New(utils.DefaultApiHost).
			Post("/v1/projects/" + projectRef + "/network-restrictions/apply").
			MatchType("json").
			JSON(api.NetworkRestrictionsRequest{
				DbAllowedCidrs:   &[]string{},
				DbAllowedCidrsV6: &[]string{},
			}).
			Reply(http.StatusServiceUnavailable)
		// Run test
		err := Run(context.Background(), projectRef, []string{}, true)
		// Check error
		assert.ErrorContains(t, err, "failed to apply network restrictions:")
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})
}

func TestValidateCIDR(t *testing.T) {
	projectRef := apitest.RandomProjectRef()
	// Setup valid access token
	token := apitest.RandomAccessToken(t)
	t.Setenv("SUPABASE_ACCESS_TOKEN", string(token))

	t.Run("bypasses private subnet checks", func(t *testing.T) {
		// Setup mock api
		defer gock.OffAll()
		gock.New(utils.DefaultApiHost).
			Post("/v1/projects/" + projectRef + "/network-restrictions/apply").
			MatchType("json").
			JSON(api.NetworkRestrictionsRequest{
				DbAllowedCidrs:   &[]string{"10.0.0.0/8"},
				DbAllowedCidrsV6: &[]string{},
			}).
			Reply(http.StatusCreated).
			JSON(api.NetworkRestrictionsResponse{
				Status: api.NetworkRestrictionsResponseStatus("applied"),
			})
		// Run test
		err := Run(context.Background(), projectRef, []string{"10.0.0.0/8"}, true)
		// Check error
		assert.NoError(t, err)
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})

	t.Run("throws error on private subnet", func(t *testing.T) {
		// Run test
		err := Run(context.Background(), projectRef, []string{"12.3.4.5/32", "10.0.0.0/8", "1.2.3.1/24"}, false)
		// Check error
		assert.ErrorContains(t, err, "private IP provided: 10.0.0.0/8")
	})

	t.Run("throws error on invalid subnet", func(t *testing.T) {
		// Run test
		err := Run(context.Background(), projectRef, []string{"12.3.4.5", "10.0.0.0/8", "1.2.3.1/24"}, false)
		// Check error
		assert.ErrorContains(t, err, "failed to parse IP: 12.3.4.5")
	})
}
