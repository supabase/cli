package delete

import (
	"context"
	"fmt"
	"net/http"
	"os"

	"github.com/go-errors/errors"
	"github.com/spf13/afero"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/internal/utils/credentials"
	"github.com/zalando/go-keyring"
)

func PreRun(ctx context.Context, ref string) error {
	if err := utils.AssertProjectRefIsValid(ref); err != nil {
		return err
	}
	title := fmt.Sprintf("Do you want to delete project %s? This action is irreversible.", utils.Aqua(ref))
	if shouldDelete, err := utils.NewConsole().PromptYesNo(ctx, title, false); err != nil {
		return err
	} else if !shouldDelete {
		return errors.New(context.Canceled)
	}
	return nil
}

func Run(ctx context.Context, ref string, fsys afero.Fs) error {
	resp, err := utils.GetSupabase().DeleteProjectWithResponse(ctx, ref)
	if err != nil {
		return errors.Errorf("failed to delete project: %w", err)
	}

	switch resp.StatusCode() {
	case http.StatusNotFound:
		return errors.New("Project does not exist:" + utils.Aqua(ref))
	case http.StatusOK:
		break
	default:
		return errors.Errorf("Failed to delete project %s: %s", utils.Aqua(ref), string(resp.Body))
	}

	// Unlink project
	if err := credentials.Delete(ref); err != nil && !errors.Is(err, keyring.ErrNotFound) {
		fmt.Fprintln(os.Stderr, err)
	}
	if match, err := afero.FileContainsBytes(fsys, utils.ProjectRefPath, []byte(ref)); match {
		tmpFiles := []string{
			utils.ProjectRefPath,
			utils.PostgresVersionPath,
			utils.GotrueVersionPath,
			utils.RestVersionPath,
			utils.StorageVersionPath,
		}
		for _, path := range tmpFiles {
			if err := fsys.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
				fmt.Fprintln(os.Stderr, err)
			}
		}
	} else if err != nil {
		logger := utils.GetDebugLogger()
		fmt.Fprintln(logger, err)
	}

	fmt.Println("Deleted project: " + utils.Aqua(resp.JSON200.Name))
	return nil
}
