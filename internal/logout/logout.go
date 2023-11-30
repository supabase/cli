package logout

import (
	"context"
	"errors"
	"fmt"
	"os"

	"github.com/spf13/afero"
	"github.com/supabase/cli/internal/utils"
)

type RunParams struct {
	Fsys afero.Fs
}

func PreRun() error {
	if !utils.PromptYesNo("Do you want to log out, which will remove the token from your system?", true, os.Stdin) {
		return errors.New("Not deleting the token")
	}
	return nil
}

func Run(ctx context.Context, stdout *os.File, params RunParams) error {
	fmt.Fprintln(stdout, "Deleting the access token. Please wait...")

	if err := utils.DeleteAccessToken(params.Fsys); err != nil {
		return err
	}

	fmt.Fprintln(stdout, "Token deleted successfully. You are now logged out.")

	return nil
}
