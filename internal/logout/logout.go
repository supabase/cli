package logout

import (
	"context"
	"fmt"
	"os"

	"github.com/spf13/afero"
	"github.com/supabase/cli/internal/utils"
)

type RunParams struct {
	Fsys afero.Fs
}

func Run(ctx context.Context, stdout *os.File, params RunParams) error {
	if !utils.PromptYesNo("Do you want to log out, which will remove the token from your system?", true, os.Stdin) {
		fmt.Fprintln(stdout, "Not deleting token")
		return nil
	}

	fmt.Fprintln(stdout, "Deleting the access token. Please wait...")

	if err := utils.DeleteAccessToken(params.Fsys); err != nil {
		if err == utils.ErrMissingToken {
			fmt.Fprintln(stdout, "You were not logged in, nothing to do.")
			return nil
		}
		return err
	}

	fmt.Fprintln(stdout, "Token deleted successfully. You are now logged out.")

	return nil
}
