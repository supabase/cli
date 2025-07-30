package download

import (
    "context"
    "fmt"
    "os"
    "path/filepath"
    "strings"

    "github.com/go-errors/errors"
    "github.com/google/uuid"
    "github.com/spf13/afero"
    "github.com/supabase/cli/internal/utils"
    "github.com/supabase/cli/internal/utils/flags"
    "github.com/supabase/cli/pkg/api"
)

func Run(ctx context.Context, testId string, fsys afero.Fs) error {
    if err := flags.LoadConfig(fsys); err != nil {
        return err
    }
    if strings.TrimSpace(testId) == "" {
        return downloadAll(ctx, fsys)
    }
    return downloadOne(ctx, testId)
}

func downloadOne(ctx context.Context, idStr string) error {
    id, err := uuid.Parse(idStr)
    if err != nil {
        return fmt.Errorf("invalid test ID: %w", err)
    }
    resp, err := utils.GetSupabase().V1ProjectGetSnippetWithResponse(ctx, flags.ProjectRef, id)
    if err != nil {
        return errors.Errorf("failed to download test: %w", err)
    }
    if resp.JSON200 == nil {
        return errors.New("unexpected error downloading SQL test: " + string(resp.Body))
    }
    if resp.JSON200.Content.Sql != nil {
        fmt.Println(*resp.JSON200.Content.Sql)
    }
    return nil
}

func downloadAll(ctx context.Context, fsys afero.Fs) error {
    testDir := utils.TestsDir
    if err := utils.MkdirIfNotExistFS(fsys, testDir); err != nil {
        return err
    }
    
    // Get list of remote tests
    t := api.V1ProjectListSnippetsParamsTypeTest
    opts := api.V1ProjectListSnippetsParams{Type: &t}
    resp, err := utils.GetSupabase().V1ProjectListSnippetsWithResponse(ctx, flags.ProjectRef, &opts)
    if err != nil {
        return errors.Errorf("failed to list tests: %w", err)
    }
    if resp.JSON200 == nil {
        return errors.New("unexpected error listing SQL tests: " + string(resp.Body))
    }
    
    // Build map of remote test names
    remoteTests := make(map[string]bool)
    
    // Download each remote test
    for _, s := range resp.JSON200.Data {
        if s.Type != api.SnippetListDataTypeTest || s.Visibility != api.SnippetListDataVisibilityProject {
            continue
        }
        fmt.Println("Downloading " + utils.Bold(s.Name))
        uid, err := uuid.Parse(s.Id)
        if err != nil {
            continue
        }
        bodyResp, err := utils.GetSupabase().V1ProjectGetSnippetWithResponse(ctx, flags.ProjectRef, uid)
        if err != nil || bodyResp.JSON200 == nil {
            continue
        }
        safeName := strings.NewReplacer("/", "_", "\\", "_").Replace(s.Name)
        filePath := filepath.Join(testDir, safeName+".sql")
        remoteTests[safeName+".sql"] = true
        
        if bodyResp.JSON200.Content.Sql == nil {
            fmt.Fprintf(os.Stderr, "missing sql content for test %s: %v\n", s.Name, err)
            continue
        }
        if err := afero.WriteFile(fsys, filePath, []byte(*bodyResp.JSON200.Content.Sql), 0644); err != nil {
            fmt.Fprintf(os.Stderr, "failed to write test %s: %v\n", s.Name, err)
        } else {
            fmt.Printf("Saved %s\n", filePath)
        }
    }

    // Check for local test files that don't exist remotely
    if exists, err := afero.DirExists(fsys, testDir); err == nil && exists {
        entries, err := afero.ReadDir(fsys, testDir)
        if err == nil {
            var localOnlyFiles []string
            for _, entry := range entries {
                if !entry.IsDir() && strings.HasSuffix(entry.Name(), ".sql") {
                    if !remoteTests[entry.Name()] {
                        localOnlyFiles = append(localOnlyFiles, entry.Name())
                    }
                }
            }
            
            if len(localOnlyFiles) > 0 {
                console := utils.NewConsole()
                testNames := make([]string, len(localOnlyFiles))
                for i, file := range localOnlyFiles {
                    testNames[i] = strings.TrimSuffix(file, ".sql")
                }
                msg := fmt.Sprintf("Your local tests directory has %d test(s) that don't exist remotely:\n  %s\nDo you want to delete them locally?", 
                    len(localOnlyFiles), strings.Join(testNames, "\n  "))
                shouldDelete, err := console.PromptYesNo(ctx, msg, false)
                if err != nil {
                    return err
                }
                if shouldDelete {
                    for _, file := range localOnlyFiles {
                        filePath := filepath.Join(testDir, file)
                        if err := fsys.Remove(filePath); err != nil {
                            fmt.Fprintf(os.Stderr, "failed to delete %s: %v\n", filePath, err)
                        } else {
                            fmt.Printf("Deleted local test %s\n", strings.TrimSuffix(file, ".sql"))
                        }
                    }
                } else {
                    fmt.Printf("Skipped deletion of %d local tests\n", len(localOnlyFiles))
                }
            }
        }
    }
    
    return nil
} 