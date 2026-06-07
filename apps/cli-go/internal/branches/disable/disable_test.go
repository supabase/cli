package disable

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

func TestDisableBranching(t *testing.T) {
	flags.ProjectRef = apitest.RandomProjectRef()

	t.Run("disables branching", func(t *testing.T) {
		t.Cleanup(apitest.MockPlatformAPI(t))
		// Setup mock api
		gock.New(utils.DefaultApiHost).
			Delete("/v1/projects/" + flags.ProjectRef + "/branches").
			Reply(http.StatusOK)
		// Run test
		err := Run(context.Background(), nil)
		assert.NoError(t, err)
	})

	t.Run("throws error on network error", func(t *testing.T) {
		errNetwork := errors.New("network error")
		t.Cleanup(apitest.MockPlatformAPI(t))
		// Setup mock api
		gock.New(utils.DefaultApiHost).
			Delete("/v1/projects/" + flags.ProjectRef + "/branches").
			ReplyError(errNetwork)
		// Run test
		err := Run(context.Background(), nil)
		assert.ErrorIs(t, err, errNetwork)
	})

	t.Run("throws error on service unavailable", func(t *testing.T) {
		t.Cleanup(apitest.MockPlatformAPI(t))
		// Setup mock api
		gock.New(utils.DefaultApiHost).
			Delete("/v1/projects/" + flags.ProjectRef + "/branches").
			Reply(http.StatusServiceUnavailable)
		// Run test
		err := Run(context.Background(), nil)
		assert.ErrorContains(t, err, "unexpected disable branching status 503:")
	})
}
