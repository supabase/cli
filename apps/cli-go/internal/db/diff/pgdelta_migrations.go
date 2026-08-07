package diff

import (
	"os"
	"path/filepath"
	"time"

	"github.com/go-errors/errors"
	"github.com/spf13/afero"
	"github.com/supabase/cli/internal/migration/new"
	"github.com/supabase/cli/internal/utils"
)

// maxVersionCollisionAttempts bounds the base-timestamp bump retry so a directory
// already full of same-second migrations can't spin forever.
const maxVersionCollisionAttempts = 60

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
//
// Before writing anything, the FULL set of generated filenames is collision-checked
// against the filesystem: if any target path already exists the base is advanced by
// one second and every version recomputed, so the set stays strictly ascending AND
// unique against pre-existing migrations. The base only ever moves forward — never
// backdated below the caller's wall clock, since backdating could sort a new file
// before pre-existing migrations. The resulting ≤N−1s future-dating is inherent to
// second-granularity versions and acceptable once uniqueness is enforced.
func WritePgDeltaMigrations(files []PgDeltaPlanFile, base time.Time, name string, fsys afero.Fs) (_ []WrittenMigration, err error) {
	// Validate the complete plan before touching the filesystem. The CLI supports
	// exactly the two pg-delta execution modes; silently treating a future or
	// misspelled mode as transactional would write a migration with wrong semantics.
	for _, file := range files {
		if err := file.TransactionMode.validate(); err != nil {
			return nil, err
		}
	}
	single := len(files) == 1
	buildSet := func(b time.Time) []WrittenMigration {
		set := make([]WrittenMigration, len(files))
		for i, file := range files {
			version := utils.GetVersionTimestamp(b.Add(time.Duration(i) * time.Second))
			fileName := name
			if !single {
				fileName = name + "_" + file.Name
			}
			set[i] = WrittenMigration{Path: new.GetMigrationPath(version, fileName), Version: version}
		}
		return set
	}

	set := buildSet(base)
	for attempt := 0; ; attempt++ {
		collision := false
		for _, w := range set {
			exists, err := afero.Exists(fsys, w.Path)
			if err != nil {
				return nil, errors.Errorf("failed to check migration file: %w", err)
			}
			if exists {
				collision = true
				break
			}
		}
		if !collision {
			break
		}
		if attempt+1 >= maxVersionCollisionAttempts {
			return nil, errors.Errorf("failed to find a unique migration version after %d attempts", maxVersionCollisionAttempts)
		}
		base = base.Add(time.Second)
		set = buildSet(base)
	}

	written := make([]WrittenMigration, 0, len(files))
	// Best-effort cleanup: if any open/write fails mid-loop, remove every file this
	// invocation already wrote so a partial multi-file migration isn't left behind.
	// A removal failure never masks the original error.
	defer func() {
		if err != nil {
			for _, w := range written {
				_ = fsys.Remove(w.Path)
			}
		}
	}()
	for i, file := range files {
		w := set[i]
		if err = utils.MkdirIfNotExistFS(fsys, filepath.Dir(w.Path)); err != nil {
			return nil, err
		}
		// O_EXCL (not O_TRUNC): a race that created the file between the collision
		// check and here must never silently overwrite an existing migration.
		f, openErr := fsys.OpenFile(w.Path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0644)
		if openErr != nil {
			err = errors.Errorf("failed to open migration file: %w", openErr)
			return nil, err
		}
		if _, writeErr := f.WriteString(file.SQL + "\n"); writeErr != nil {
			f.Close()
			err = errors.Errorf("failed to write migration file: %w", writeErr)
			return nil, err
		}
		f.Close()
		written = append(written, w)
	}
	return written, nil
}
