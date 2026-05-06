package pause

import (
	"context"
	"errors"
	"net/http"
	"testing"

	"github.com/google/uuid"
	"github.com/h2non/gock"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"github.com/supabase/cli/internal/testing/apitest"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/internal/utils/flags"
	"github.com/supabase/cli/pkg/api"
)

func TestPauseBranch(t *testing.T) {
	flags.ProjectRef = apitest.RandomProjectRef()

	t.Run("pauses a branch", func(t *testing.T) {
		t.Cleanup(apitest.MockPlatformAPI(t))
		// Setup mock api
		gock.New(utils.DefaultApiHost).
			Post("/v1/projects/" + flags.ProjectRef + "/pause").
			Reply(http.StatusOK)
		// Run test
		err := Run(context.Background(), flags.ProjectRef)
		assert.NoError(t, err)
	})

	t.Run("throws error on network error", func(t *testing.T) {
		errNetwork := errors.New("network error")
		t.Cleanup(apitest.MockPlatformAPI(t))
		// Setup mock api
		gock.New(utils.DefaultApiHost).
			Post("/v1/projects/" + flags.ProjectRef + "/pause").
			ReplyError(errNetwork)
		// Run test
		err := Run(context.Background(), flags.ProjectRef)
		assert.ErrorIs(t, err, errNetwork)
	})

	t.Run("throws error on service unavailable", func(t *testing.T) {
		t.Cleanup(apitest.MockPlatformAPI(t))
		// Setup mock api
		gock.New(utils.DefaultApiHost).
			Post("/v1/projects/" + flags.ProjectRef + "/pause").
			Reply(http.StatusServiceUnavailable)
		// Run test
		err := Run(context.Background(), flags.ProjectRef)
		assert.ErrorContains(t, err, "unexpected pause branch status 503:")
	})
}

func TestBranchProjectRef(t *testing.T) {
	flags.ProjectRef = apitest.RandomProjectRef()

	t.Run("get by name", func(t *testing.T) {
		branchRef := apitest.RandomProjectRef()
		t.Cleanup(apitest.MockPlatformAPI(t))
		// Setup mock api
		gock.New(utils.DefaultApiHost).
			Get("/v1/projects/" + flags.ProjectRef + "/branches/develop").
			Reply(http.StatusOK).
			JSON(api.BranchResponse{ProjectRef: branchRef})
		// run test
		ref, err := GetBranchProjectRef(context.Background(), "develop")
		assert.NoError(t, err)
		assert.Equal(t, branchRef, ref)
	})

	t.Run("throws error on missing branch", func(t *testing.T) {
		t.Cleanup(apitest.MockPlatformAPI(t))
		// Setup mock api
		gock.New(utils.DefaultApiHost).
			Get("/v1/projects/" + flags.ProjectRef + "/branches/missing").
			Reply(http.StatusNotFound)
		// Run test
		_, err := GetBranchProjectRef(context.Background(), "missing")
		assert.ErrorContains(t, err, "unexpected find branch status 404:")
	})

	t.Run("get by id", func(t *testing.T) {
		brancRef := apitest.RandomProjectRef()
		branchId, err := uuid.NewUUID()
		require.NoError(t, err)
		t.Cleanup(apitest.MockPlatformAPI(t))
		// Setup mock api
		gock.New(utils.DefaultApiHost).
			Get("/v1/branches/" + branchId.String()).
			Reply(http.StatusOK).
			JSON(api.BranchDetailResponse{Ref: brancRef})
		// Run test
		ref, err := GetBranchProjectRef(context.Background(), branchId.String())
		assert.NoError(t, err)
		assert.Equal(t, brancRef, ref)
	})

	t.Run("throws error on network error", func(t *testing.T) {
		errNetwork := errors.New("network error")
		branchId, err := uuid.NewUUID()
		require.NoError(t, err)
		t.Cleanup(apitest.MockPlatformAPI(t))
		// Setup mock api
		gock.New(utils.DefaultApiHost).
			Get("/v1/branches/" + branchId.String()).
			ReplyError(errNetwork)
		// Run test
		_, err = GetBranchProjectRef(context.Background(), branchId.String())
		assert.ErrorIs(t, err, errNetwork)
	})

	t.Run("throws error on service unavailable", func(t *testing.T) {
		branchId, err := uuid.NewUUID()
		require.NoError(t, err)
		t.Cleanup(apitest.MockPlatformAPI(t))
		// Setup mock api
		gock.New(utils.DefaultApiHost).
			Get("/v1/branches/" + branchId.String()).
			Reply(http.StatusServiceUnavailable)
		// Run test
		_, err = GetBranchProjectRef(context.Background(), branchId.String())
		assert.ErrorContains(t, err, "unexpected get branch status 503:")
	})
}
