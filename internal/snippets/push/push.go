package push

import (
    "context"
    "fmt"
    "path/filepath"
    "strings"

    "github.com/go-errors/errors"
    "github.com/google/uuid"
    "github.com/spf13/afero"
    "github.com/supabase/cli/internal/utils"
    "github.com/supabase/cli/internal/utils/flags"
    "github.com/supabase/cli/pkg/api"
)

// schemaVersion is hard-coded to 1 until versioning support is implemented
const schemaVersion = "1"

func Run(ctx context.Context, fsys afero.Fs) error {
    // Load project config (for project ref etc.)
    if err := flags.LoadConfig(fsys); err != nil {
        return err
    }

    // Resolve snippets directory
    snippetsDir := utils.SnippetsDir
    exists, err := afero.DirExists(fsys, snippetsDir)
    if err != nil {
        return errors.Errorf("failed to access snippets directory: %w", err)
    }
    if !exists {
        return errors.Errorf("%s does not exist. Have you downloaded or created any snippets?", utils.Bold(snippetsDir))
    }

    // Read local snippet files (*.sql)
    entries, err := afero.ReadDir(fsys, snippetsDir)
    if err != nil {
        return errors.Errorf("failed to read snippets directory: %w", err)
    }

    localSnippets := make(map[string]string) // name -> sql
    for _, entry := range entries {
        if entry.IsDir() {
            continue
        }
        if strings.HasSuffix(entry.Name(), ".sql") {
            name := strings.TrimSuffix(entry.Name(), ".sql")
            path := filepath.Join(snippetsDir, entry.Name())
            bytes, err := afero.ReadFile(fsys, path)
            if err != nil {
                return errors.Errorf("failed to read %s: %w", path, err)
            }
            localSnippets[name] = string(bytes)
        }
    }

    if len(localSnippets) == 0 {
        return errors.New("no .sql files found in snippets directory")
    }

    // Fetch remote project snippets to map name -> id
    remoteMap, err := fetchRemoteSnippets(ctx)
    if err != nil {
        return err
    }

    // Upsert each local snippet
    for name, sql := range localSnippets {
        if id, ok := remoteMap[name]; ok {
            if err := upsertSnippet(ctx, id, name, sql); err != nil {
                fmt.Fprintf(utils.GetDebugLogger(), "failed to update snippet %s: %v\n", name, err)
            } else {
                fmt.Println("Updated snippet " + utils.Aqua(name))
            }
        } else {
            if err := createSnippet(ctx, name, sql); err != nil {
                fmt.Fprintf(utils.GetDebugLogger(), "failed to create snippet %s: %v\n", name, err)
            } else {
                fmt.Println("Created snippet " + utils.Aqua(name))
            }
        }
    }

    // Delete remote snippets that no longer exist locally
    var toDelete []uuid.UUID
    var toDeleteNames []string
    for name, id := range remoteMap {
        if _, ok := localSnippets[name]; !ok {
            toDelete = append(toDelete, id)
            toDeleteNames = append(toDeleteNames, name)
        }
    }
    if len(toDelete) > 0 {
        console := utils.NewConsole()
        msg := fmt.Sprintf("Your remote project has %d snippet(s) that don't exist locally:\n  %s\nDo you want to delete them from the remote project?", 
            len(toDelete), strings.Join(toDeleteNames, "\n  "))
        shouldDelete, err := console.PromptYesNo(ctx, msg, false)
        if err != nil {
            return err
        }
        if shouldDelete {
            for _, id := range toDelete {
                utils.GetSupabase().V1ProjectDeleteSnippetWithResponse(ctx, flags.ProjectRef, id)
            }
            fmt.Printf("Deleted %d obsolete snippets\n", len(toDelete))
        } else {
            fmt.Printf("Skipped deletion of %d remote snippets\n", len(toDelete))
        }
    }

    return nil
}

func fetchRemoteSnippets(ctx context.Context) (map[string]uuid.UUID, error) {
    t := api.V1ProjectListSnippetsParamsTypeSql
    opts := api.V1ProjectListSnippetsParams{Type: &t}
    resp, err := utils.GetSupabase().V1ProjectListSnippetsWithResponse(ctx, flags.ProjectRef, &opts)
    if err != nil {
        return nil, errors.Errorf("failed to list snippets: %w", err)
    }
    if resp.JSON200 == nil {
        return nil, errors.New("unexpected error listing SQL snippets: " + string(resp.Body))
    }
    result := make(map[string]uuid.UUID)
    for _, s := range resp.JSON200.Data {
        if s.Visibility != api.SnippetListDataVisibilityProject || s.Type != api.SnippetListDataTypeSql {
            continue
        }
        // parse uuid from id string
        uid, err := uuid.Parse(s.Id)
        if err != nil {
            continue
        }
        result[s.Name] = uid
    }
    return result, nil
}

func upsertSnippet(ctx context.Context, id uuid.UUID, name, sql string) error {
    content := map[string]interface{}{
        "favorite":       false,
        "schema_version": schemaVersion,
        "sql":            sql,
    }
    body := api.UpsertContentBody{
        Id:         id.String(),
        Name:       name,
        OwnerId:    0,
        Type:       api.UpsertContentBodyTypeSql,
        Visibility: api.UpsertContentBodyVisibilityProject,
        Content:    &content,
    }
    resp, err := utils.GetSupabase().V1ProjectUpsertSnippetWithResponse(ctx, flags.ProjectRef, id, body)
    if err != nil {
        return errors.Errorf("failed to upsert snippet: %w", err)
    }
    if resp.StatusCode() >= 300 {
        return errors.New("failed to upsert snippet: " + string(resp.Body))
    }
    return nil
}

func createSnippet(ctx context.Context, name, sql string) error {
    content := map[string]interface{}{
        "favorite":       false,
        "schema_version": schemaVersion,
        "sql":            sql,
    }
    body := api.CreateContentBody{
        Name:       name,
        Type:       api.CreateContentBodyTypeSql,
        Visibility: api.CreateContentBodyVisibilityProject,
        Content:    &content,
    }
    resp, err := utils.GetSupabase().V1ProjectCreateSnippetWithResponse(ctx, flags.ProjectRef, body)
    if err != nil {
        return errors.Errorf("failed to create snippet: %w", err)
    }
    if resp.StatusCode() >= 300 {
        return errors.New("failed to create snippet: " + string(resp.Body))
    }
    return nil
} 