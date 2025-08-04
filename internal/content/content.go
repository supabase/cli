package content

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

const schemaVersion = "1"

type ContentType string

const (
	ContentTypeTest    ContentType = "test"
	ContentTypeSnippet ContentType = "snippet"
)

type Config struct {
	Type        ContentType
	Directory   string
	DisplayName string
}

func GetConfig(contentType ContentType) Config {
	switch contentType {
	case ContentTypeTest:
		return Config{
			Type:        ContentTypeTest,
			Directory:   utils.TestsDir,
			DisplayName: "test",
		}
	case ContentTypeSnippet:
		return Config{
			Type:        ContentTypeSnippet,
			Directory:   utils.SnippetsDir,
			DisplayName: "snippet",
		}
	default:
		panic("unsupported content type")
	}
}

func Push(ctx context.Context, fsys afero.Fs, contentType ContentType) error {
	if err := flags.LoadConfig(fsys); err != nil {
		return err
	}

	config := GetConfig(contentType)
	
	exists, err := afero.DirExists(fsys, config.Directory)
	if err != nil || !exists {
		return errors.Errorf("%s does not exist", config.Directory)
	}

	entries, err := afero.ReadDir(fsys, config.Directory)
	if err != nil {
		return err
	}

	locals := map[string]string{}
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".sql") {
			continue
		}
		name := strings.TrimSuffix(e.Name(), ".sql")
		bytes, _ := afero.ReadFile(fsys, filepath.Join(config.Directory, e.Name()))
		locals[name] = string(bytes)
	}

	if len(locals) == 0 {
		fmt.Printf("No %s files found to push\n", config.DisplayName)
		return nil
	}

	remote, err := listRemote(ctx, contentType)
	if err != nil {
		return err
	}

	for name, sql := range locals {
		if id, ok := remote[name]; ok {
			if err := upsert(ctx, contentType, id, name, sql); err != nil {
				fmt.Fprintf(utils.GetDebugLogger(), "failed to update %s %s: %v\n", config.DisplayName, name, err)
			} else {
				fmt.Printf("Updated %s %s\n", config.DisplayName, utils.Aqua(name))
			}
		} else {
			if err := create(ctx, contentType, name, sql); err != nil {
				fmt.Fprintf(utils.GetDebugLogger(), "failed to create %s %s: %v\n", config.DisplayName, name, err)
			} else {
				fmt.Printf("Created %s %s\n", config.DisplayName, utils.Aqua(name))
			}
		}
	}

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
		msg := fmt.Sprintf("Your remote project has %d %s(s) that don't exist locally:\n  %s\nDo you want to delete them from the remote project?",
			len(deletions), config.DisplayName, strings.Join(deletionNames, "\n  "))
		shouldDelete, err := console.PromptYesNo(ctx, msg, false)
		if err != nil {
			return err
		}
		if shouldDelete {
			for _, id := range deletions {
				utils.GetSupabase().V1ProjectDeleteSnippet(ctx, flags.ProjectRef, id)
			}
			fmt.Printf("Deleted %d obsolete %ss\n", len(deletions), config.DisplayName)
		} else {
			fmt.Printf("Skipped deletion of %d remote %ss\n", len(deletions), config.DisplayName)
		}
	}
	return nil
}

func DownloadAll(ctx context.Context, fsys afero.Fs, contentType ContentType) error {
	if err := flags.LoadConfig(fsys); err != nil {
		return err
	}

	config := GetConfig(contentType)
	
	if err := utils.MkdirIfNotExistFS(fsys, config.Directory); err != nil {
		return err
	}

	listType := getListParamsType(contentType)
	opts := api.V1ProjectListSnippetsParams{Type: &listType}
	resp, err := utils.GetSupabase().V1ProjectListSnippetsWithResponse(ctx, flags.ProjectRef, &opts)
	if err != nil {
		return errors.Errorf("failed to list %ss: %w", config.DisplayName, err)
	}
	if resp.JSON200 == nil {
		return errors.New("unexpected error listing SQL " + config.DisplayName + "s: " + string(resp.Body))
	}

	remoteItems := make(map[string]bool)

	for _, s := range resp.JSON200.Data {
		if s.Visibility != api.SnippetListDataVisibilityProject || !isCorrectType(s.Type, contentType) {
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
		safeName := sanitizeFilename(s.Name)
		filePath := filepath.Join(config.Directory, safeName+".sql")
		remoteItems[safeName+".sql"] = true

		if bodyResp.JSON200.Content.Sql == nil {
			fmt.Fprintf(os.Stderr, "missing sql content for %s %s: %v\n", config.DisplayName, s.Name, err)
			continue
		}
		if err := afero.WriteFile(fsys, filePath, []byte(*bodyResp.JSON200.Content.Sql), 0644); err != nil {
			fmt.Fprintf(os.Stderr, "failed to write %s %s: %v\n", config.DisplayName, s.Name, err)
		} else {
			fmt.Printf("Downloaded %s %s to %s\n", config.DisplayName, utils.Aqua(s.Name), filePath)
		}
	}

	if exists, err := afero.DirExists(fsys, config.Directory); err == nil && exists {
		entries, err := afero.ReadDir(fsys, config.Directory)
		if err == nil {
			var localOnlyFiles []string
			for _, entry := range entries {
				if !entry.IsDir() && strings.HasSuffix(entry.Name(), ".sql") {
					if !remoteItems[entry.Name()] {
						localOnlyFiles = append(localOnlyFiles, entry.Name())
					}
				}
			}

			if len(localOnlyFiles) > 0 {
				console := utils.NewConsole()
				itemNames := make([]string, len(localOnlyFiles))
				for i, file := range localOnlyFiles {
					itemNames[i] = strings.TrimSuffix(file, ".sql")
				}
				msg := fmt.Sprintf("Your local %ss directory has %d %s(s) that don't exist remotely:\n  %s\nDo you want to delete them locally?",
					config.DisplayName, len(localOnlyFiles), config.DisplayName, strings.Join(itemNames, "\n  "))
				shouldDelete, err := console.PromptYesNo(ctx, msg, false)
				if err != nil {
					return err
				}
				if shouldDelete {
					for _, file := range localOnlyFiles {
						filePath := filepath.Join(config.Directory, file)
						if err := fsys.Remove(filePath); err != nil {
							fmt.Fprintf(os.Stderr, "failed to delete %s: %v\n", filePath, err)
						} else {
							fmt.Printf("Deleted local %s %s\n", config.DisplayName, strings.TrimSuffix(file, ".sql"))
						}
					}
				} else {
					fmt.Printf("Skipped deletion of %d local %ss\n", len(localOnlyFiles), config.DisplayName)
				}
			}
		}
	}

	return nil
}

func DownloadOne(ctx context.Context, fsys afero.Fs, itemId string, contentType ContentType) error {
	if err := flags.LoadConfig(fsys); err != nil {
		return err
	}

	id, err := uuid.Parse(itemId)
	if err != nil {
		return fmt.Errorf("invalid %s ID: %w", GetConfig(contentType).DisplayName, err)
	}
	resp, err := utils.GetSupabase().V1ProjectGetSnippetWithResponse(ctx, flags.ProjectRef, id)
	if err != nil {
		return errors.Errorf("failed to download %s: %w", GetConfig(contentType).DisplayName, err)
	}
	if resp.JSON200 == nil {
		return errors.New("unexpected error downloading SQL " + GetConfig(contentType).DisplayName + ": " + string(resp.Body))
	}

	if !isCorrectResponseType(resp.JSON200.Type, contentType) || resp.JSON200.Visibility != api.SnippetResponseVisibilityProject {
		return errors.New("requested item is not a project SQL " + GetConfig(contentType).DisplayName)
	}

	if resp.JSON200.Content.Sql != nil {
		fmt.Println(*resp.JSON200.Content.Sql)
	}
	return nil
}

func listRemote(ctx context.Context, contentType ContentType) (map[string]uuid.UUID, error) {
	listType := getListParamsType(contentType)
	opts := api.V1ProjectListSnippetsParams{Type: &listType}
	resp, err := utils.GetSupabase().V1ProjectListSnippetsWithResponse(ctx, flags.ProjectRef, &opts)
	if err != nil {
		return nil, err
	}
	if resp.JSON200 == nil {
		return nil, errors.New(string(resp.Body))
	}
	m := map[string]uuid.UUID{}
	for _, s := range resp.JSON200.Data {
		if !isCorrectType(s.Type, contentType) || s.Visibility != api.SnippetListDataVisibilityProject {
			continue
		}
		id, err := uuid.Parse(s.Id)
		if err == nil {
			m[s.Name] = id
		}
	}
	return m, nil
}

func upsert(ctx context.Context, contentType ContentType, id uuid.UUID, name, sql string) error {
	content := map[string]interface{}{
		"favorite":       false,
		"schema_version": schemaVersion,
		"sql":            sql,
	}
	body := api.UpsertContentBody{
		Id:         id.String(),
		Name:       name,
		OwnerId:    0,
		Type:       getUpsertBodyType(contentType),
		Visibility: api.UpsertContentBodyVisibilityProject,
		Content:    &content,
	}
	resp, err := utils.GetSupabase().V1ProjectUpsertSnippetWithResponse(ctx, flags.ProjectRef, id, body)
	if err != nil {
		return errors.Errorf("failed to upsert: %w", err)
	}
	if resp.StatusCode() >= 300 {
		return errors.New("failed to upsert: " + string(resp.Body))
	}
	return nil
}

func create(ctx context.Context, contentType ContentType, name, sql string) error {
	content := map[string]interface{}{
		"favorite":       false,
		"schema_version": schemaVersion,
		"sql":            sql,
	}
	body := api.CreateContentBody{
		Name:       name,
		Type:       getCreateBodyType(contentType),
		Visibility: api.CreateContentBodyVisibilityProject,
		Content:    &content,
	}
	resp, err := utils.GetSupabase().V1ProjectCreateSnippetWithResponse(ctx, flags.ProjectRef, body)
	if err != nil {
		return errors.Errorf("failed to create: %w", err)
	}
	if resp.StatusCode() >= 300 {
		return errors.New("failed to create: " + string(resp.Body))
	}
	return nil
}

func sanitizeFilename(name string) string {
	replacer := strings.NewReplacer("/", "_", "\\", "_")
	return replacer.Replace(name)
}

func getListParamsType(contentType ContentType) api.V1ProjectListSnippetsParamsType {
	switch contentType {
	case ContentTypeTest:
		return api.V1ProjectListSnippetsParamsTypeTest
	case ContentTypeSnippet:
		return api.V1ProjectListSnippetsParamsTypeSql
	default:
		panic("unsupported content type")
	}
}

func getUpsertBodyType(contentType ContentType) api.UpsertContentBodyType {
	switch contentType {
	case ContentTypeTest:
		return api.UpsertContentBodyTypeTest
	case ContentTypeSnippet:
		return api.UpsertContentBodyTypeSql
	default:
		panic("unsupported content type")
	}
}

func getCreateBodyType(contentType ContentType) api.CreateContentBodyType {
	switch contentType {
	case ContentTypeTest:
		return api.CreateContentBodyTypeTest
	case ContentTypeSnippet:
		return api.CreateContentBodyTypeSql
	default:
		panic("unsupported content type")
	}
}

func isCorrectType(apiType api.SnippetListDataType, contentType ContentType) bool {
	switch contentType {
	case ContentTypeTest:
		return apiType == api.SnippetListDataTypeTest
	case ContentTypeSnippet:
		return apiType == api.SnippetListDataTypeSql
	default:
		return false
	}
}

func isCorrectResponseType(apiType api.SnippetResponseType, contentType ContentType) bool {
	switch contentType {
	case ContentTypeTest:
		return apiType == api.SnippetResponseTypeTest
	case ContentTypeSnippet:
		return apiType == api.SnippetResponseTypeSql
	default:
		return false
	}
}