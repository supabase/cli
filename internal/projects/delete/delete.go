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

func PreRun(ref string) error {
	if err := utils.AssertProjectRefIsValid(ref); err != nil {
		return err
	}
	if !utils.PromptYesNo("Do you want to delete project "+utils.Aqua(ref)+"? This action is irreversible.", true, os.Stdin) {
		return errors.New("Not deleting project: " + utils.Aqua(ref))
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
	if match, _ := afero.FileContainsBytes(fsys, utils.ProjectRefPath, []byte(ref)); match {
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
	}

	fmt.Println("Deleted project: " + utils.Aqua(resp.JSON200.Name))
	return nil
}
