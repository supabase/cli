package unpause

import (
	"context"
	"net/http"
	"testing"

	"github.com/go-errors/errors"
	"github.com/h2non/gock"
	"github.com/stretchr/testify/assert"
	"github.com/supabase/cli/internal/testing/apitest"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/internal/utils/flags"
)

func TestUnpauseBranch(t *testing.T) {
	flags.ProjectRef = apitest.RandomProjectRef()

	t.Run("unpause a branch", func(t *testing.T) {
		t.Cleanup(apitest.MockPlatformAPI(t))
		// Setup mock api
		gock.New(utils.DefaultApiHost).
			Post("/v1/projects/" + flags.ProjectRef + "/restore").
			Reply(http.StatusOK)
		// Run test
		err := Run(context.Background(), flags.ProjectRef)
		assert.NoError(t, err)
	})

	t.Run("throws error on missing branch", func(t *testing.T) {
		errNetwork := errors.New("network error")
		t.Cleanup(apitest.MockPlatformAPI(t))
		// Setup mock api
		gock.New(utils.DefaultApiHost).
			Get("/v1/projects/" + flags.ProjectRef + "/branches/missing").
			ReplyError(errNetwork)
		// Run test
		err := Run(context.Background(), "missing")
		assert.ErrorIs(t, err, errNetwork)
	})

	t.Run("throws error on network error", func(t *testing.T) {
		errNetwork := errors.New("network error")
		t.Cleanup(apitest.MockPlatformAPI(t))
		// Setup mock api
		gock.New(utils.DefaultApiHost).
			Post("/v1/projects/" + flags.ProjectRef + "/restore").
			ReplyError(errNetwork)
		// Run test
		err := Run(context.Background(), flags.ProjectRef)
		assert.ErrorIs(t, err, errNetwork)
	})

	t.Run("throws error on service unavailable", func(t *testing.T) {
		t.Cleanup(apitest.MockPlatformAPI(t))
		// Setup mock api
		gock.New(utils.DefaultApiHost).
			Post("/v1/projects/" + flags.ProjectRef + "/restore").
			Reply(http.StatusServiceUnavailable)
		// Run test
		err := Run(context.Background(), flags.ProjectRef)
		assert.ErrorContains(t, err, "unexpected unpause branch status 503:")
	})
}
