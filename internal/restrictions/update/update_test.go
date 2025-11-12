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
		currentV4 := []string{"2.2.2.2/32"}
		currentV6 := []string{"2001:db8:ffff::0/64"}
		respBody := api.NetworkRestrictionsResponse{}
		respBody.Config.DbAllowedCidrs = &currentV4
		respBody.Config.DbAllowedCidrsV6 = &currentV6
		gock.New(utils.DefaultApiHost).
			Get("/v1/projects/" + projectRef + "/network-restrictions").
			Reply(http.StatusOK).
			JSON(respBody)
		expectedV4 := append([]string{}, currentV4...)
		expectedV4 = append(expectedV4, "12.3.4.5/32", "1.2.3.1/24")
		expectedV6 := append([]string{}, currentV6...)
		expectedV6 = append(expectedV6, "2001:db8:abcd:0012::0/64")
		gock.New(utils.DefaultApiHost).
			Post("/v1/projects/" + projectRef + "/network-restrictions/apply").
			MatchType("json").
			JSON(api.NetworkRestrictionsRequest{
				DbAllowedCidrs:   &expectedV4,
				DbAllowedCidrsV6: &expectedV6,
			}).
			Reply(http.StatusCreated).
			JSON(api.NetworkRestrictionsResponse{
				Status: api.NetworkRestrictionsResponseStatus("applied"),
			})
		// Run test
		// Include duplicates and an existing CIDR to verify deduplication
		err := Run(context.Background(), projectRef, []string{"12.3.4.5/32", "12.3.4.5/32", "1.2.3.1/24", "2.2.2.2/32", "2001:db8:abcd:0012::0/64", "2001:db8:abcd:0012::0/64"}, false, true)
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
		err := Run(context.Background(), projectRef, []string{}, true, false)
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
		err := Run(context.Background(), projectRef, []string{}, true, false)
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
		err := Run(context.Background(), projectRef, []string{"10.0.0.0/8"}, true, false)
		// Check error
		assert.NoError(t, err)
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})

	t.Run("throws error on private subnet", func(t *testing.T) {
		// Run test
		err := Run(context.Background(), projectRef, []string{"12.3.4.5/32", "10.0.0.0/8", "1.2.3.1/24"}, false, false)
		// Check error
		assert.ErrorContains(t, err, "private IP provided: 10.0.0.0/8")
	})

	t.Run("throws error on invalid subnet", func(t *testing.T) {
		// Run test
		err := Run(context.Background(), projectRef, []string{"12.3.4.5", "10.0.0.0/8", "1.2.3.1/24"}, false, false)
		// Check error
		assert.ErrorContains(t, err, "failed to parse IP: 12.3.4.5")
	})
}
