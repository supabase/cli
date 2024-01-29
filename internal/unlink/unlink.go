package unlink

import (
	"context"
	"fmt"
	"os"

	"github.com/go-errors/errors"
	"github.com/spf13/afero"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/internal/utils/credentials"
	"github.com/supabase/cli/internal/utils/flags"
	"github.com/zalando/go-keyring"
)

func Run(ctx context.Context, fsys afero.Fs) error {
	projectRef, err := flags.LoadProjectRef(fsys)
	if err != nil {
		return err
	}

	fmt.Fprintln(os.Stderr, "Unlinking project:", projectRef)
	// Remove temp directory
	if err := fsys.RemoveAll(utils.TempDir); err != nil {
		return errors.Errorf("failed to remove temp directory: %w", err)
	}
	// Remove linked credentials
	if err := credentials.Delete(projectRef); err != nil &&
		!errors.Is(err, credentials.ErrNotSupported) &&
		!errors.Is(err, keyring.ErrNotFound) {
		return err
	}

	fmt.Fprintln(os.Stdout, "Finished "+utils.Aqua("supabase unlink")+".")
	return nil
}
