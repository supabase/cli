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

// TestPushCommand verifies that running `supabase snippets push` succeeds when
// local snippets differ from remote ones and the user auto-confirms deletions.
func TestPushCommand(t *testing.T) {
    // Automatically answer all prompts with "yes"
    viper.Set("YES", true)
    // Random project ref and valid access token
    flags.ProjectRef = apitest.RandomProjectRef()
    token := apitest.RandomAccessToken(t)
    t.Setenv("SUPABASE_ACCESS_TOKEN", string(token))

    // Prepare in-memory filesystem with one local snippet "hello.sql"
    fsys := afero.NewMemMapFs()
    snippetDir := utils.SnippetsDir
    require.NoError(t, fsys.MkdirAll(snippetDir, 0755))
    require.NoError(t, afero.WriteFile(fsys, filepath.Join(snippetDir, "hello.sql"), []byte("select 1;"), 0644))

    // Prepare mock API
    helloID := uuid.New()
    orphanID := uuid.New()
    defer gock.OffAll()
    // List existing snippets
    gock.New(utils.DefaultApiHost).
        Get("/v1/projects/" + flags.ProjectRef + "/snippets").
        MatchParam("type", "sql").
        Reply(http.StatusOK).
        JSON(map[string]interface{}{ // minimal JSON required by the client
            "data": []map[string]interface{}{
                {"id": helloID.String(), "name": "hello", "type": "sql", "visibility": "project"},
                {"id": orphanID.String(), "name": "orphan", "type": "sql", "visibility": "project"},
            },
        })
    // Upsert local snippet "hello"
    gock.New(utils.DefaultApiHost).
        Put("/v1/projects/" + flags.ProjectRef + "/snippets/" + helloID.String()).
        Reply(http.StatusOK)
    // Delete remote orphaned snippet after confirmation
    gock.New(utils.DefaultApiHost).
        Delete("/v1/projects/" + flags.ProjectRef + "/snippets/" + orphanID.String()).
        Reply(http.StatusOK)

    // Execute command
    err := Run(context.Background(), fsys)
    assert.NoError(t, err)
    assert.Empty(t, apitest.ListUnmatchedRequests())
} 