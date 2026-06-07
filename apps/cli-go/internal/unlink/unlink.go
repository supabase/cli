package unlink

import (
	"context"
	"fmt"
	"os"

	"github.com/go-errors/errors"
	"github.com/spf13/afero"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/internal/utils/credentials"
	"github.com/zalando/go-keyring"
)

func Run(ctx context.Context, fsys afero.Fs) error {
	if projectRef, err := afero.ReadFile(fsys, utils.ProjectRefPath); errors.Is(err, os.ErrNotExist) {
		return errors.New(utils.ErrNotLinked)
	} else if err != nil {
		return errors.Errorf("failed to load project ref: %w", err)
	} else if err := Unlink(string(projectRef), fsys); err != nil {
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
	if err := credentials.StoreProvider.Delete(projectRef); err != nil &&
		!errors.Is(err, credentials.ErrNotSupported) &&
		!errors.Is(err, keyring.ErrNotFound) {
		allErrors = append(allErrors, err)
	}
	return errors.Join(allErrors...)
}
