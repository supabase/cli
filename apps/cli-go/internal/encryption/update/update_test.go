package update

import (
	"context"
	"errors"
	"net/http"
	"testing"

	"github.com/h2non/gock"
	"github.com/stretchr/testify/assert"
	"github.com/supabase/cli/internal/testing/apitest"
	"github.com/supabase/cli/internal/testing/fstest"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/pkg/api"
)

func TestUpdateRootKey(t *testing.T) {
	project := apitest.RandomProjectRef()

	t.Run("updates project encryption key", func(t *testing.T) {
		t.Cleanup(fstest.MockStdin(t, "test-key"))
		t.Cleanup(apitest.MockPlatformAPI(t))
		// Setup mock api
		gock.New(utils.DefaultApiHost).
			Put("/v1/projects/" + project + "/pgsodium").
			JSON(api.UpdatePgsodiumConfigBody{RootKey: "test-key"}).
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
			Put("/v1/projects/" + project + "/pgsodium").
			ReplyError(errNetwork)
		// Run test
		err := Run(context.Background(), project)
		assert.ErrorIs(t, err, errNetwork)
	})

	t.Run("throws error on service unavailable", func(t *testing.T) {
		t.Cleanup(apitest.MockPlatformAPI(t))
		// Setup mock api
		gock.New(utils.DefaultApiHost).
			Put("/v1/projects/" + project + "/pgsodium").
			Reply(http.StatusServiceUnavailable)
		// Run test
		err := Run(context.Background(), project)
		assert.ErrorContains(t, err, "unexpected update pgsodium config status 503:")
	})
}
