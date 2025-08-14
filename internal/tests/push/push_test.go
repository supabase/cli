package push

import (
    "context"
    "net/http"
    "path/filepath"
    "testing"

    "github.com/h2non/gock"
    "github.com/google/uuid"
    "github.com/spf13/afero"
    "github.com/spf13/viper"
    "github.com/stretchr/testify/assert"
    "github.com/stretchr/testify/require"
    "github.com/supabase/cli/internal/testing/apitest"
    "github.com/supabase/cli/internal/utils"
    "github.com/supabase/cli/internal/utils/flags"
)

func TestPushCommand(t *testing.T) {
    viper.Set("YES", true)
    flags.ProjectRef = apitest.RandomProjectRef()
    token := apitest.RandomAccessToken(t)
    t.Setenv("SUPABASE_ACCESS_TOKEN", string(token))

    fsys := afero.NewMemMapFs()
    testsDir := utils.TestsDir
    require.NoError(t, fsys.MkdirAll(testsDir, 0755))
    require.NoError(t, afero.WriteFile(fsys, filepath.Join(testsDir, "alpha.sql"), []byte("select 1;"), 0644))

    alphaID := uuid.New()
    betaID := uuid.New()
    defer gock.OffAll()
    gock.New(utils.DefaultApiHost).
        Get("/v1/projects/" + flags.ProjectRef + "/snippets").
        MatchParam("type", "test").
        Reply(http.StatusOK).
        JSON(map[string]interface{}{
            "data": []map[string]interface{}{
                {"id": alphaID.String(), "name": "alpha", "type": "test", "visibility": "project"},
                {"id": betaID.String(), "name": "beta", "type": "test", "visibility": "project"},
            },
        })
    gock.New(utils.DefaultApiHost).
        Put("/v1/projects/" + flags.ProjectRef + "/snippets/" + alphaID.String()).
        Reply(http.StatusOK)
    gock.New(utils.DefaultApiHost).
        Delete("/v1/projects/" + flags.ProjectRef + "/snippets/" + betaID.String()).
        Reply(http.StatusOK)

    err := Run(context.Background(), fsys)
    assert.NoError(t, err)
    assert.Empty(t, apitest.ListUnmatchedRequests())
} 