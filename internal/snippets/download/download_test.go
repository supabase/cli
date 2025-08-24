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
    snippetsDir := utils.SnippetsDir
    require.NoError(t, fsys.MkdirAll(snippetsDir, 0755))
    // Pre-create an orphan file that should be deleted after confirmation
    orphanPath := filepath.Join(snippetsDir, "old.sql")
    require.NoError(t, afero.WriteFile(fsys, orphanPath, []byte("old"), 0644))

    // Prepare remote snippet "new"
    newID := uuid.New()
    defer gock.OffAll()
    gock.New(utils.DefaultApiHost).
        Get("/v1/projects/" + flags.ProjectRef + "/snippets").
        MatchParam("type", "sql").
        Reply(http.StatusOK).
        JSON(map[string]interface{}{
            "data": []map[string]interface{}{
                {"id": newID.String(), "name": "new", "type": "sql", "visibility": "project"},
            },
        })
    gock.New(utils.DefaultApiHost).
        Get("/v1/projects/" + flags.ProjectRef + "/snippets/" + newID.String()).
        Reply(http.StatusOK).
        JSON(map[string]interface{}{
            "content": map[string]interface{}{"sql": "select 1;"},
            "type": "sql",
            "visibility": "project",
        })

    // Run download (empty id downloads all)
    err := Run(context.Background(), "", fsys)
    assert.NoError(t, err)

    // Verify new file created and orphan removed
    exists, _ := afero.Exists(fsys, filepath.Join(snippetsDir, "new.sql"))
    assert.True(t, exists)
    orphanExists, _ := afero.Exists(fsys, orphanPath)
    assert.False(t, orphanExists)
    assert.Empty(t, apitest.ListUnmatchedRequests())
} 