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
	"github.com/supabase/cli/internal/utils/flags"
	"github.com/supabase/cli/pkg/api"
)

func TestUpdateSSL(t *testing.T) {
	flags.ProjectRef = apitest.RandomProjectRef()

	t.Run("enable ssl enforcement", func(t *testing.T) {
		t.Cleanup(fstest.MockStdout(t, "SSL is being enforced.\n"))
		t.Cleanup(apitest.MockPlatformAPI(t))
		// Setup mock api
		gock.New(utils.DefaultApiHost).
			Put("v1/projects/" + flags.ProjectRef + "/ssl-enforcement").
			Reply(http.StatusOK).
			JSON(api.SslEnforcementResponse{
				AppliedSuccessfully: true,
				CurrentConfig: struct {
					Database bool `json:"database"`
				}{
					Database: true,
				},
			})
		// Run test
		err := Run(context.Background(), flags.ProjectRef, true, nil)
		assert.NoError(t, err)
	})

	t.Run("encodes toml format", func(t *testing.T) {
		utils.OutputFormat.Value = utils.OutputEnv
		t.Cleanup(func() { utils.OutputFormat.Value = utils.OutputPretty })
		t.Cleanup(fstest.MockStdout(t, `APPLIEDSUCCESSFULLY="false"
CURRENTCONFIG_DATABASE="false"
`))
		t.Cleanup(apitest.MockPlatformAPI(t))
		// Setup mock api
		gock.New(utils.DefaultApiHost).
			Put("v1/projects/" + flags.ProjectRef + "/ssl-enforcement").
			Reply(http.StatusOK).
			JSON(api.SslEnforcementResponse{})
		// Run test
		err := Run(context.Background(), flags.ProjectRef, false, nil)
		assert.NoError(t, err)
	})

	t.Run("throws error on network error", func(t *testing.T) {
		errNetwork := errors.New("network error")
		t.Cleanup(apitest.MockPlatformAPI(t))
		// Setup mock api
		gock.New(utils.DefaultApiHost).
			Put("/v1/projects/" + flags.ProjectRef + "/ssl-enforcement").
			ReplyError(errNetwork)
		// Run test
		err := Run(context.Background(), flags.ProjectRef, false, nil)
		assert.ErrorIs(t, err, errNetwork)
	})

	t.Run("throws error on service unavailable", func(t *testing.T) {
		utils.OutputFormat.Value = utils.OutputEnv
		t.Cleanup(func() { utils.OutputFormat.Value = utils.OutputPretty })
		t.Cleanup(apitest.MockPlatformAPI(t))
		// Setup mock api
		gock.New(utils.DefaultApiHost).
			Put("/v1/projects/" + flags.ProjectRef + "/ssl-enforcement").
			Reply(http.StatusServiceUnavailable)
		// Run test
		err := Run(context.Background(), flags.ProjectRef, false, nil)
		assert.ErrorContains(t, err, "unexpected update SSL status 503:")
	})
}
