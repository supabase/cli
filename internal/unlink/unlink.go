package unlink

import (
	"context"
	"fmt"
	"io"

	"github.com/spf13/afero"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/internal/utils/credentials"
)

func PreRun(projectRef string, fsys afero.Fs) error {
	return utils.LoadConfigFS(fsys)
}

func Run(ctx context.Context, projectRef string, fsys afero.Fs) error {
	// Remove temp directory
	if err := removeTempDir(fsys); err != nil {
		return err
	}
	// Remove linked credentials
	if err := removeLinkedCredentials(projectRef); err != nil {
		return err
	}
	fmt.Println("Successfully unlinked project.")
	return nil
}

func PostRun(projectRef string, stdout io.Writer, fsys afero.Fs) error {
	fmt.Fprintln(stdout, "Finished "+utils.Aqua("supabase unlink")+".")
	return nil
}

// removeLinkedCredentials removes the database password associated with the projectRef
func removeLinkedCredentials(projectRef string) error {
	fmt.Printf("Removing credentials for project %s...\n", projectRef)
	if err := credentials.Delete(projectRef); err != nil {
		return fmt.Errorf("failed to remove credentials for project '%s': %w", projectRef, err)
	}
	fmt.Println("Credentials for project", projectRef, "have been successfully removed.")
	return nil
}

func removeTempDir(fsys afero.Fs) error {
	tempDir := utils.TempDir
	if err := fsys.RemoveAll(tempDir); err != nil {
		return fmt.Errorf("failed to remove temp directory %s: %w", tempDir, err)
	}
	return nil
}
