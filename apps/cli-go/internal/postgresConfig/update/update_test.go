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
	"github.com/supabase/cli/pkg/cast"
)

func TestUpdatePostgresConfig(t *testing.T) {
	flags.ProjectRef = apitest.RandomProjectRef()

	t.Run("updates postgres config", func(t *testing.T) {
		t.Cleanup(fstest.MockStdout(t, `
  
   Parameter       | Value 
  -----------------|-------
   max_connections | 100   

`))
		t.Cleanup(apitest.MockPlatformAPI(t))
		// Setup mock api
		gock.New(utils.DefaultApiHost).
			Put("v1/projects/" + flags.ProjectRef + "/config/database/postgres").
			Reply(http.StatusOK).
			JSON(api.PostgresConfigResponse{
				MaxConnections: cast.Ptr(100),
			})
		// Run test
		err := Run(context.Background(), flags.ProjectRef, []string{
			"max_connections=100",
			"track_commit_timestamp=true",
			"statement_timeout=600",
			"wal_keep_size=1GB",
		}, true, true, nil)
		assert.NoError(t, err)
	})

	t.Run("throws error on missing key", func(t *testing.T) {
		err := Run(context.Background(), flags.ProjectRef, []string{"value"}, true, true, nil)
		assert.ErrorContains(t, err, "expected config value in key:value format")
	})

	t.Run("throws error on missing project", func(t *testing.T) {
		errNetwork := errors.New("network error")
		t.Cleanup(apitest.MockPlatformAPI(t))
		// Setup mock api
		gock.New(utils.DefaultApiHost).
			Get("v1/projects/" + flags.ProjectRef + "/config/database/postgres").
			ReplyError(errNetwork)
		// Run test
		err := Run(context.Background(), flags.ProjectRef, []string{}, false, false, nil)
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
		err := Run(context.Background(), flags.ProjectRef, []string{}, false, false, nil)
		assert.ErrorIs(t, err, errNetwork)
	})

	t.Run("throws error on service unavailable", func(t *testing.T) {
		utils.OutputFormat.Value = utils.OutputEnv
		t.Cleanup(func() { utils.OutputFormat.Value = utils.OutputPretty })
		t.Cleanup(apitest.MockPlatformAPI(t))
		// Setup mock api
		gock.New(utils.DefaultApiHost).
			Put("/v1/projects/" + flags.ProjectRef + "/config/database/postgres").
			Reply(http.StatusServiceUnavailable)
		// Run test
		err := Run(context.Background(), flags.ProjectRef, []string{}, true, true, nil)
		assert.ErrorContains(t, err, "unexpected update config overrides status 503:")
	})
}
