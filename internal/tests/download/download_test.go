package download

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

func TestDownloadAll(t *testing.T) {
    viper.Set("YES", true)
    flags.ProjectRef = apitest.RandomProjectRef()
    token := apitest.RandomAccessToken(t)
    t.Setenv("SUPABASE_ACCESS_TOKEN", string(token))

    fsys := afero.NewMemMapFs()
    testsDir := utils.TestsDir
    require.NoError(t, fsys.MkdirAll(testsDir, 0755))
    orphanPath := filepath.Join(testsDir, "legacy.sql")
    require.NoError(t, afero.WriteFile(fsys, orphanPath, []byte("legacy"), 0644))

    newID := uuid.New()
    defer gock.OffAll()
    gock.New(utils.DefaultApiHost).
        Get("/v1/projects/" + flags.ProjectRef + "/snippets").
        MatchParam("type", "test").
        Reply(http.StatusOK).
        JSON(map[string]interface{}{
            "data": []map[string]interface{}{
                {"id": newID.String(), "name": "delta", "type": "test", "visibility": "project"},
            },
        })
    gock.New(utils.DefaultApiHost).
        Get("/v1/projects/" + flags.ProjectRef + "/snippets/" + newID.String()).
        Reply(http.StatusOK).
        JSON(map[string]interface{}{
            "content": map[string]interface{}{"sql": "select 2;"},
            "type": "test",
            "visibility": "project",
        })

    err := Run(context.Background(), "", fsys)
    assert.NoError(t, err)

    exists, _ := afero.Exists(fsys, filepath.Join(testsDir, "delta.sql"))
    assert.True(t, exists)
    orphanExists, _ := afero.Exists(fsys, orphanPath)
    assert.False(t, orphanExists)
    assert.Empty(t, apitest.ListUnmatchedRequests())
} 