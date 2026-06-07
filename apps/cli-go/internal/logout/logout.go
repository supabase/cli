package logout

import (
	"context"
	"fmt"
	"os"

	"github.com/go-errors/errors"
	"github.com/spf13/afero"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/internal/utils/credentials"
)

func Run(ctx context.Context, stdout *os.File, fsys afero.Fs) error {
	if shouldLogout, err := utils.NewConsole().PromptYesNo(ctx, "Do you want to log out? This will remove the access token from your system.", false); err != nil {
		return err
	} else if !shouldLogout {
		return errors.New(context.Canceled)
	}

	if err := utils.DeleteAccessToken(fsys); errors.Is(err, utils.ErrNotLoggedIn) {
		fmt.Fprintln(os.Stderr, err)
		return nil
	} else if err != nil {
		return err
	}

	// Delete all possible stored project credentials
	if err := credentials.StoreProvider.DeleteAll(); err != nil {
		fmt.Fprintln(utils.GetDebugLogger(), err)
	}

	fmt.Fprintln(stdout, "Access token deleted successfully. You are now logged out.")
	return nil
}
