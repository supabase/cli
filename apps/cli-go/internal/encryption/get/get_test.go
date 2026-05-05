package get

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

func TestGetRootKey(t *testing.T) {
	project := apitest.RandomProjectRef()

	t.Run("fetches project encryption key", func(t *testing.T) {
		t.Cleanup(apitest.MockPlatformAPI(t))
		// Setup mock api
		gock.New(utils.DefaultApiHost).
			Get("/v1/projects/" + project + "/pgsodium").
			Reply(http.StatusOK).
			JSON(api.PgsodiumConfigResponse{RootKey: "test-key"})
		// Run test
		err := Run(context.Background(), project)
		assert.NoError(t, err)
	})

	t.Run("throws error on network error", func(t *testing.T) {
		errNetwork := errors.New("network error")
		t.Cleanup(apitest.MockPlatformAPI(t))
		// Setup mock api
		gock.New(utils.DefaultApiHost).
			Get("/v1/projects/" + project + "/pgsodium").
			ReplyError(errNetwork)
		// Run test
		err := Run(context.Background(), project)
		assert.ErrorIs(t, err, errNetwork)
	})

	t.Run("throws error on service unavailable", func(t *testing.T) {
		t.Cleanup(apitest.MockPlatformAPI(t))
		// Setup mock api
		gock.New(utils.DefaultApiHost).
			Get("/v1/projects/" + project + "/pgsodium").
			Reply(http.StatusServiceUnavailable)
		// Run test
		err := Run(context.Background(), project)
		assert.ErrorContains(t, err, "unexpected get pgsodium config status 503:")
	})
}
