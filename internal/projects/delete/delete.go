package delete

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"os"

	"github.com/spf13/afero"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/internal/utils/credentials"
	"github.com/zalando/go-keyring"
)

func PreRun(ref string) error {
	if err := utils.AssertProjectRefIsValid(ref); err != nil {
		return err
	}
	if !utils.PromptYesNo("Do you want to delete project "+utils.Aqua(ref)+"? This action is irreversible.", false, os.Stdin) {
		return errors.New("Not deleting project: " + utils.Aqua(ref))
	}
	return nil
}

func Run(ctx context.Context, ref string, fsys afero.Fs) error {
	resp, err := utils.GetSupabase().DeleteProjectWithResponse(ctx, ref)
	if err != nil {
		return err
	}

	switch resp.StatusCode() {
	case http.StatusNotFound:
		return errors.New("Project " + utils.Aqua(ref) + " does not exist.")
	case http.StatusOK:
		break
	default:
		return errors.New("Failed to delete project " + utils.Aqua(ref) + ": " + string(resp.Body))
	}

	// Unlink project
	if err := credentials.Delete(ref); err != nil && !errors.Is(err, keyring.ErrNotFound) {
		fmt.Fprintln(os.Stderr, err)
	}
	if match, _ := afero.FileContainsBytes(fsys, utils.ProjectRefPath, []byte(ref)); match {
		if err := fsys.Remove(utils.ProjectRefPath); err != nil {
			fmt.Fprintln(os.Stderr, err)
		}
	}

	fmt.Println("Deleted Project " + utils.Aqua(ref) + ".")
	return nil
}
