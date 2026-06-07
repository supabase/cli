package get

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

func TestGetHostname(t *testing.T) {
	flags.ProjectRef = apitest.RandomProjectRef()

	t.Run("fetches custom hostname", func(t *testing.T) {
		t.Cleanup(apitest.MockPlatformAPI(t))
		// Setup mock api
		gock.New(utils.DefaultApiHost).
			Get("v1/projects/" + flags.ProjectRef + "/custom-hostname").
			Reply(http.StatusOK).
			JSON(api.UpdateCustomHostnameResponse{})
		// Run test
		err := Run(context.Background(), flags.ProjectRef, nil)
		assert.NoError(t, err)
	})

	t.Run("encodes toml output", func(t *testing.T) {
		utils.OutputFormat.Value = utils.OutputToml
		t.Cleanup(func() { utils.OutputFormat.Value = utils.OutputPretty })
		t.Cleanup(fstest.MockStdout(t, `CustomHostname = ""
Status = "5_services_reconfigured"

[Data]
  Success = false
  [Data.Result]
    CustomOriginServer = ""
    Hostname = ""
    Id = ""
    Status = ""
    [Data.Result.OwnershipVerification]
      Name = ""
      Type = ""
      Value = ""
    [Data.Result.Ssl]
      Status = ""
`))
		t.Cleanup(apitest.MockPlatformAPI(t))
		// Setup mock api
		gock.New(utils.DefaultApiHost).
			Get("v1/projects/" + flags.ProjectRef + "/custom-hostname").
			Reply(http.StatusOK).
			JSON(api.UpdateCustomHostnameResponse{
				Status: api.N5ServicesReconfigured,
			})
		// Run test
		err := Run(context.Background(), flags.ProjectRef, nil)
		assert.NoError(t, err)
	})

	t.Run("throws error on network error", func(t *testing.T) {
		errNetwork := errors.New("network error")
		t.Cleanup(apitest.MockPlatformAPI(t))
		// Setup mock api
		gock.New(utils.DefaultApiHost).
			Get("v1/projects/" + flags.ProjectRef + "/custom-hostname").
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
			Get("v1/projects/" + flags.ProjectRef + "/custom-hostname").
			Reply(http.StatusServiceUnavailable)
		// Run test
		err := Run(context.Background(), flags.ProjectRef, nil)
		assert.ErrorContains(t, err, "unexpected get hostname status 503:")
	})
}
