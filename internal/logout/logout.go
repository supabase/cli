package logout

import (
	"context"
	"fmt"
	"os"

	"github.com/go-errors/errors"
	"github.com/spf13/afero"
	"github.com/supabase/cli/internal/utils"
)

func Run(ctx context.Context, stdout *os.File, fsys afero.Fs) error {
	if !utils.PromptYesNo("Do you want to log out? This will remove the access token from your system.", false, os.Stdin) {
		fmt.Fprintln(os.Stderr, "Not deleting access token.")
		return nil
	}

	if err := utils.DeleteAccessToken(fsys); errors.Is(err, utils.ErrNotLoggedIn) {
		fmt.Fprintln(os.Stderr, err)
		return nil
	} else if err != nil {
		return err
	}

	fmt.Fprintln(stdout, "Access token deleted successfully. You are now logged out.")
	return nil
}
