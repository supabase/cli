package diff

import (
	"os"
	"time"

	"github.com/go-errors/errors"
	"github.com/spf13/afero"
	"github.com/supabase/cli/internal/migration/new"
	"github.com/supabase/cli/internal/utils"
)

// WrittenMigration is a migration file produced by a diff/pull, paired with the
// version to record in the remote migration history.
type WrittenMigration struct {
	Path    string
	Version string
}

// WritePgDeltaMigrations writes one ordered migration file per plan unit. A
// single-unit plan (the common case) keeps the exact `<ts>_<name>.sql` filename;
// multi-unit plans append the unit name and give each file a strictly increasing
// timestamp (real time arithmetic on the base, never string increment) so their
// execution order and migration-history order stay stable.
func WritePgDeltaMigrations(files []PgDeltaPlanFile, base time.Time, name string, fsys afero.Fs) ([]WrittenMigration, error) {
	if err := utils.MkdirIfNotExistFS(fsys, utils.MigrationsDir); err != nil {
		return nil, err
	}
	single := len(files) == 1
	written := make([]WrittenMigration, 0, len(files))
	for i, file := range files {
		version := utils.GetVersionTimestamp(base.Add(time.Duration(i) * time.Second))
		fileName := name
		if !single {
			fileName = name + "_" + file.Name
		}
		path := new.GetMigrationPath(version, fileName)
		f, err := fsys.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0644)
		if err != nil {
			return nil, errors.Errorf("failed to open migration file: %w", err)
		}
		if _, err := f.WriteString(file.SQL + "\n"); err != nil {
			f.Close()
			return nil, errors.Errorf("failed to write migration file: %w", err)
		}
		f.Close()
		written = append(written, WrittenMigration{Path: path, Version: version})
	}
	return written, nil
}
