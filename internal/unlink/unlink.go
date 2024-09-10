package unlink

import (
	"context"
	"fmt"
	"os"

	"github.com/go-errors/errors"
	"github.com/spf13/afero"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/internal/utils/credentials"
	"github.com/supabase/cli/internal/utils/credentials/keyring"
	"github.com/supabase/cli/internal/utils/flags"
)

func Run(ctx context.Context, fsys afero.Fs) error {
	projectRef, err := flags.LoadProjectRef(fsys)
	if err != nil {
		return err
	}
	if err := Unlink(projectRef, fsys); err != nil {
		return err
	}
	fmt.Fprintln(os.Stdout, "Finished "+utils.Aqua("supabase unlink")+".")
	return nil
}

func Unlink(projectRef string, fsys afero.Fs) error {
	fmt.Fprintln(os.Stderr, "Unlinking project:", projectRef)
	var allErrors []error
	// Remove temp directory
	if err := fsys.RemoveAll(utils.TempDir); err != nil {
		wrapped := errors.Errorf("failed to remove temp directory: %w", err)
		allErrors = append(allErrors, wrapped)
	}
	// Remove linked credentials
	if err := credentials.Delete(projectRef); err != nil &&
		!errors.Is(err, credentials.ErrNotSupported) &&
		!errors.Is(err, keyring.ErrNotFound) {
		allErrors = append(allErrors, err)
	}
	return errors.Join(allErrors...)
}
