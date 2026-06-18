package logout

import (
	"context"
	"fmt"
	"os"

	"github.com/go-errors/errors"
	"github.com/spf13/afero"
	phtelemetry "github.com/supabase/cli/internal/telemetry"
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
		// Still forget the telemetry identity: a stale distinct_id can outlive
		// the token (e.g. the token file was removed manually).
		if cerr := phtelemetry.FromContext(ctx).ResetIdentity(); cerr != nil {
			fmt.Fprintln(utils.GetDebugLogger(), cerr)
		}
		fmt.Fprintln(os.Stderr, err)
		return nil
	} else if err != nil {
		return err
	}

	// Delete all possible stored project credentials
	if err := credentials.StoreProvider.DeleteAll(); err != nil {
		fmt.Fprintln(utils.GetDebugLogger(), err)
	}

	if err := phtelemetry.FromContext(ctx).ResetIdentity(); err != nil {
		fmt.Fprintln(utils.GetDebugLogger(), err)
	}

	fmt.Fprintln(stdout, "Access token deleted successfully. You are now logged out.")
	return nil
}
