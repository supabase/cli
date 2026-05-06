package get

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

func TestGetSubdomain(t *testing.T) {
	flags.ProjectRef = apitest.RandomProjectRef()

	t.Run("get vanity subdomains", func(t *testing.T) {
		t.Cleanup(fstest.MockStdout(t, `Status: custom-domain-used
Vanity subdomain: example.com
`))
		t.Cleanup(apitest.MockPlatformAPI(t))
		// Setup mock api
		gock.New(utils.DefaultApiHost).
			Get("v1/projects/" + flags.ProjectRef + "/vanity-subdomain").
			Reply(http.StatusOK).
			JSON(api.VanitySubdomainConfigResponse{
				CustomDomain: cast.Ptr("example.com"),
				Status:       api.CustomDomainUsed,
			})
		// Run test
		err := Run(context.Background(), flags.ProjectRef, nil)
		assert.NoError(t, err)
	})

	t.Run("encodes toml output", func(t *testing.T) {
		utils.OutputFormat.Value = utils.OutputToml
		t.Cleanup(func() { utils.OutputFormat.Value = utils.OutputPretty })
		t.Cleanup(fstest.MockStdout(t, `Status = "not-used"
`))
		t.Cleanup(apitest.MockPlatformAPI(t))
		// Setup mock api
		gock.New(utils.DefaultApiHost).
			Get("v1/projects/" + flags.ProjectRef + "/vanity-subdomain").
			Reply(http.StatusOK).
			JSON(api.VanitySubdomainConfigResponse{
				Status: api.NotUsed,
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
			Get("/v1/projects/" + flags.ProjectRef + "/vanity-subdomain").
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
			Get("/v1/projects/" + flags.ProjectRef + "/vanity-subdomain").
			Reply(http.StatusServiceUnavailable)
		// Run test
		err := Run(context.Background(), flags.ProjectRef, nil)
		assert.ErrorContains(t, err, "unexpected vanity subdomain status 503:")
	})
}
