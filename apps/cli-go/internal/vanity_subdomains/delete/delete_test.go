package delete

import (
	"context"
	"errors"
	"net/http"
	"testing"

	"github.com/h2non/gock"
	"github.com/stretchr/testify/assert"
	"github.com/supabase/cli/internal/testing/apitest"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/internal/utils/flags"
)

func TestDeleteSubdomain(t *testing.T) {
	flags.ProjectRef = apitest.RandomProjectRef()

	t.Run("deletes vanity subdomain", func(t *testing.T) {
		t.Cleanup(apitest.MockPlatformAPI(t))
		// Setup mock api
		gock.New(utils.DefaultApiHost).
			Delete("v1/projects/" + flags.ProjectRef + "/vanity-subdomain").
			Reply(http.StatusOK)
		// Run test
		err := Run(context.Background(), flags.ProjectRef, nil)
		assert.NoError(t, err)
	})

	t.Run("throws error on network error", func(t *testing.T) {
		errNetwork := errors.New("network error")
		t.Cleanup(apitest.MockPlatformAPI(t))
		// Setup mock api
		gock.New(utils.DefaultApiHost).
			Delete("/v1/projects/" + flags.ProjectRef + "/vanity-subdomain").
			ReplyError(errNetwork)
		// Run test
		err := Run(context.Background(), flags.ProjectRef, nil)
		assert.ErrorIs(t, err, errNetwork)
	})

	t.Run("throws error on service unavailable", func(t *testing.T) {
		utils.OutputFormat.Value = utils.OutputEnv
		t.Cleanup(func() { utils.OutputFormat.Value = utils.OutputPretty })
		t.Cleanup(apitest.MockPlatformAPI(t))
		// Setup mock api
		gock.New(utils.DefaultApiHost).
			Delete("/v1/projects/" + flags.ProjectRef + "/vanity-subdomain").
			Reply(http.StatusServiceUnavailable)
		// Run test
		err := Run(context.Background(), flags.ProjectRef, nil)
		assert.ErrorContains(t, err, "unexpected delete vanity subdomain status 503:")
	})
}
