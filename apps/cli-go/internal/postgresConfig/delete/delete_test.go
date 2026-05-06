package delete

import (
	"context"
	"net/http"
	"testing"

	"github.com/go-errors/errors"
	"github.com/h2non/gock"
	"github.com/stretchr/testify/assert"
	"github.com/supabase/cli/internal/testing/apitest"
	"github.com/supabase/cli/internal/testing/fstest"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/internal/utils/flags"
	"github.com/supabase/cli/pkg/api"
	"github.com/supabase/cli/pkg/cast"
)

func TestDeleteConfig(t *testing.T) {
	flags.ProjectRef = apitest.RandomProjectRef()

	t.Run("deletes postgres config", func(t *testing.T) {
		t.Cleanup(fstest.MockStdout(t, `
  
   Parameter | Value 
  -----------|-------

`))
		t.Cleanup(apitest.MockPlatformAPI(t))
		// Setup mock api
		gock.New(utils.DefaultApiHost).
			Get("v1/projects/" + flags.ProjectRef + "/config/database/postgres").
			Reply(http.StatusOK).
			JSON(api.PostgresConfigResponse{
				MaxConnections: cast.Ptr(100),
			})
		gock.New(utils.DefaultApiHost).
			Put("v1/projects/" + flags.ProjectRef + "/config/database/postgres").
			Reply(http.StatusOK).
			JSON(api.PostgresConfigResponse{})
		// Run test
		err := Run(context.Background(), flags.ProjectRef, []string{"max_connections"}, true, nil)
		assert.NoError(t, err)
	})

	t.Run("throws error on missing project", func(t *testing.T) {
		errNetwork := errors.New("network error")
		t.Cleanup(apitest.MockPlatformAPI(t))
		// Setup mock api
		gock.New(utils.DefaultApiHost).
			Get("/v1/projects/" + flags.ProjectRef + "/config/database/postgres").
			ReplyError(errNetwork)
		// Run test
		err := Run(context.Background(), flags.ProjectRef, []string{}, false, nil)
		assert.ErrorIs(t, err, errNetwork)
	})

	t.Run("throws error on network error", func(t *testing.T) {
		errNetwork := errors.New("network error")
		t.Cleanup(apitest.MockPlatformAPI(t))
		// Setup mock api
		gock.New(utils.DefaultApiHost).
			Get("v1/projects/" + flags.ProjectRef + "/config/database/postgres").
			Reply(http.StatusOK).
			JSON(api.PostgresConfigResponse{
				MaxConnections: cast.Ptr(100),
			})
		gock.New(utils.DefaultApiHost).
			Put("/v1/projects/" + flags.ProjectRef + "/config/database/postgres").
			ReplyError(errNetwork)
		// Run test
		err := Run(context.Background(), flags.ProjectRef, []string{}, false, nil)
		assert.ErrorIs(t, err, errNetwork)
	})

	t.Run("throws error on service unavailable", func(t *testing.T) {
		utils.OutputFormat.Value = utils.OutputEnv
		t.Cleanup(func() { utils.OutputFormat.Value = utils.OutputPretty })
		t.Cleanup(apitest.MockPlatformAPI(t))
		// Setup mock api
		gock.New(utils.DefaultApiHost).
			Get("v1/projects/" + flags.ProjectRef + "/config/database/postgres").
			Reply(http.StatusOK).
			JSON(api.PostgresConfigResponse{
				MaxConnections: cast.Ptr(100),
			})
		gock.New(utils.DefaultApiHost).
			Put("/v1/projects/" + flags.ProjectRef + "/config/database/postgres").
			Reply(http.StatusServiceUnavailable)
		// Run test
		err := Run(context.Background(), flags.ProjectRef, []string{}, false, nil)
		assert.ErrorContains(t, err, "unexpected delete config overrides status 503:")
	})
}
