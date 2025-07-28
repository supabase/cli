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

const schemaVersion = "1"

func Run(ctx context.Context, fsys afero.Fs) error {
    if err := flags.LoadConfig(fsys); err != nil {
        return err
    }
    dir := utils.TestsDir
    exists, err := afero.DirExists(fsys, dir)
    if err != nil || !exists {
        return errors.Errorf("%s does not exist", dir)
    }
    entries, err := afero.ReadDir(fsys, dir)
    if err != nil { return err }
    locals := map[string]string{}
    for _, e := range entries {
        if e.IsDir() || !strings.HasSuffix(e.Name(), ".sql") { continue }
        name := strings.TrimSuffix(e.Name(), ".sql")
        bytes, _ := afero.ReadFile(fsys, filepath.Join(dir, e.Name()))
        locals[name] = string(bytes)
    }
    if len(locals)==0 { return errors.New("no sql files found") }
    remote, err := listRemote(ctx)
    if err != nil { return err }
    for name, sql := range locals {
        if id, ok := remote[name]; ok {
            upsert(ctx, id, name, sql)
        } else { create(ctx, name, sql) }
    }

    // remove remote tests missing locally
    var deletions []uuid.UUID
    var deletionNames []string
    for name, id := range remote {
        if _, ok := locals[name]; !ok {
            deletions = append(deletions, id)
            deletionNames = append(deletionNames, name)
        }
    }
    if len(deletions) > 0 {
        console := utils.NewConsole()
        msg := fmt.Sprintf("Your remote project has %d test(s) that don't exist locally:\n  %s\nDo you want to delete them from the remote project?", 
            len(deletions), strings.Join(deletionNames, "\n  "))
        shouldDelete, err := console.PromptYesNo(ctx, msg, false)
        if err != nil {
            return err
        }
        if shouldDelete {
            for _, id := range deletions {
                utils.GetSupabase().V1ProjectDeleteSnippet(ctx, flags.ProjectRef, id)
            }
            fmt.Printf("Deleted %d obsolete tests\n", len(deletions))
        } else {
            fmt.Printf("Skipped deletion of %d remote tests\n", len(deletions))
        }
    }
    return nil
}

func listRemote(ctx context.Context) (map[string]uuid.UUID, error) {
    t := api.V1ProjectListSnippetsParamsTypeTest
    opts := api.V1ProjectListSnippetsParams{Type: &t}
    resp, err := utils.GetSupabase().V1ProjectListSnippetsWithResponse(ctx, flags.ProjectRef, &opts)
    if err != nil {
        return nil, err
    }
    if resp.JSON200 == nil {
        return nil, errors.New(string(resp.Body))
    }
    m := map[string]uuid.UUID{}
    for _, s := range resp.JSON200.Data {
        if s.Type != api.SnippetListDataTypeTest || s.Visibility != api.SnippetListDataVisibilityProject {
            continue
        }
        id, err := uuid.Parse(s.Id)
        if err == nil {
            m[s.Name] = id
        }
    }
    return m, nil
}

func upsert(ctx context.Context, id uuid.UUID, name, sql string) {
    content := map[string]interface{}{
        "favorite":       false,
        "schema_version": schemaVersion,
        "sql":            sql,
    }
    body := api.UpsertContentBody{Id: id.String(), Name: name, OwnerId: 0, Type: api.UpsertContentBodyTypeTest, Visibility: api.UpsertContentBodyVisibilityProject, Content: &content}
    utils.GetSupabase().V1ProjectUpsertSnippet(ctx, flags.ProjectRef, id, body)
    fmt.Println("Updated test " + utils.Aqua(name))
}

func create(ctx context.Context, name, sql string) {
    content := map[string]interface{}{
        "favorite":       false,
        "schema_version": schemaVersion,
        "sql":            sql,
    }
    body := api.CreateContentBody{Name: name, Type: api.CreateContentBodyTypeTest, Visibility: api.CreateContentBodyVisibilityProject, Content: &content}
    utils.GetSupabase().V1ProjectCreateSnippet(ctx, flags.ProjectRef, body)
    fmt.Println("Created test " + utils.Aqua(name))
} 