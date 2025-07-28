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

// Run downloads a single snippet when snippetId is provided, otherwise
// downloads all snippets in the project and stores them under
// supabase/snippets.
func Run(ctx context.Context, snippetId string, fsys afero.Fs) error {
	// Load local project config to populate default project ref if not provided.
	if err := flags.LoadConfig(fsys); err != nil {
		return err
	}
	if strings.TrimSpace(snippetId) == "" {
		return downloadAll(ctx, fsys)
	}
	return downloadOne(ctx, snippetId, fsys)
}

// downloadOne fetches the specified snippet and prints its SQL content to stdout.
func downloadOne(ctx context.Context, snippetId string, fsys afero.Fs) error {
	// Convert string to UUID
	id, err := uuid.Parse(snippetId)
	if err != nil {
		return fmt.Errorf("invalid snippet ID: %w", err)
	}
	resp, err := utils.GetSupabase().V1ProjectGetSnippetWithResponse(ctx, flags.ProjectRef, id)
	if err != nil {
		return errors.Errorf("failed to download snippet: %w", err)
	}

	if resp.JSON200 == nil {
		return errors.New("Unexpected error downloading SQL snippet: " + string(resp.Body))
	}

	// Ensure we only process project-visible SQL snippets
	if resp.JSON200.Type != api.SnippetResponseTypeSql || resp.JSON200.Visibility != api.SnippetResponseVisibilityProject {
		return errors.New("requested snippet is not a project SQL snippet")
	}

	if resp.JSON200.Content.Sql != nil {
		fmt.Println(*resp.JSON200.Content.Sql)
	}
	return nil
}

// downloadAll fetches the list of snippets for the current project and writes
// each snippet's SQL into a local file under supabase/snippets.
func downloadAll(ctx context.Context, fsys afero.Fs) error {
	// Ensure snippets directory exists
	snippetsDir := utils.SnippetsDir
	if err := utils.MkdirIfNotExistFS(fsys, snippetsDir); err != nil {
		return err
	}

	t := api.V1ProjectListSnippetsParamsTypeSql
	opts := api.V1ProjectListSnippetsParams{Type: &t}
	listResp, err := utils.GetSupabase().V1ProjectListSnippetsWithResponse(ctx, flags.ProjectRef, &opts)
	if err != nil {
		return errors.Errorf("failed to list snippets: %w", err)
	}

	if listResp.JSON200 == nil {
		return errors.New("Unexpected error listing SQL snippets: " + string(listResp.Body))
	}

	// Build map of remote snippet names
	remoteSnippets := make(map[string]bool)

	// Download each remote snippet
	for _, snippet := range listResp.JSON200.Data {
		if snippet.Visibility != api.SnippetListDataVisibilityProject || snippet.Type != api.SnippetListDataTypeSql {
			continue
		}
		id := snippet.Id
		name := sanitizeFilename(snippet.Name)
		filePath := filepath.Join(snippetsDir, fmt.Sprintf("%s.sql", name))
		remoteSnippets[name+".sql"] = true

		fmt.Println("Downloading " + utils.Bold(name))
		// Fetch snippet content
		uuidId, err := uuid.Parse(id)
		if err != nil {
			fmt.Fprintf(os.Stderr, "skipping invalid snippet id %s: %v\n", id, err)
			continue
		}
		resp, err := utils.GetSupabase().V1ProjectGetSnippetWithResponse(ctx, flags.ProjectRef, uuidId)
		if err != nil {
			fmt.Fprintf(os.Stderr, "failed to download snippet %s: %v\n", id, err)
			continue
		}
		if resp.JSON200 == nil {
			fmt.Fprintf(os.Stderr, "unexpected response downloading snippet %s: %s\n", id, string(resp.Body))
			continue
		}

		if resp.JSON200.Content.Sql == nil {
			fmt.Fprintf(os.Stderr, "missing sql content for snippet %s\n", id)
			continue
		}
		if err := afero.WriteFile(fsys, filePath, []byte(*resp.JSON200.Content.Sql), 0644); err != nil {
			fmt.Fprintf(os.Stderr, "failed to write snippet %s: %v\n", id, err)
			continue
		}
		fmt.Printf("Downloaded snippet %s to %s\n", utils.Aqua(snippet.Name), filePath)
	}

	// Check for local snippet files that don't exist remotely
	if exists, err := afero.DirExists(fsys, snippetsDir); err == nil && exists {
		entries, err := afero.ReadDir(fsys, snippetsDir)
		if err == nil {
			var localOnlyFiles []string
			for _, entry := range entries {
				if !entry.IsDir() && strings.HasSuffix(entry.Name(), ".sql") {
					if !remoteSnippets[entry.Name()] {
						localOnlyFiles = append(localOnlyFiles, entry.Name())
					}
				}
			}
			
			if len(localOnlyFiles) > 0 {
				console := utils.NewConsole()
				snippetNames := make([]string, len(localOnlyFiles))
				for i, file := range localOnlyFiles {
					snippetNames[i] = strings.TrimSuffix(file, ".sql")
				}
				msg := fmt.Sprintf("Your local snippets directory has %d snippet(s) that don't exist remotely:\n  %s\nDo you want to delete them locally?", 
					len(localOnlyFiles), strings.Join(snippetNames, "\n  "))
				shouldDelete, err := console.PromptYesNo(ctx, msg, false)
				if err != nil {
					return err
				}
				if shouldDelete {
					for _, file := range localOnlyFiles {
						filePath := filepath.Join(snippetsDir, file)
						if err := fsys.Remove(filePath); err != nil {
							fmt.Fprintf(os.Stderr, "failed to delete %s: %v\n", filePath, err)
						} else {
							fmt.Printf("Deleted local snippet %s\n", strings.TrimSuffix(file, ".sql"))
						}
					}
				} else {
					fmt.Printf("Skipped deletion of %d local snippets\n", len(localOnlyFiles))
				}
			}
		}
	}

	return nil
}

// sanitizeFilename creates a file-system safe name by replacing spaces and
// path separators with underscores.
func sanitizeFilename(name string) string {
	// Replace path separators with underscore; keep other characters (incl. spaces) intact.
	replacer := strings.NewReplacer("/", "_", "\\", "_")
	return replacer.Replace(name)
}
