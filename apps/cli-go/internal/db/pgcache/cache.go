package pgcache

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/spf13/afero"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/pkg/migration"
)

const (
	pgDeltaTempDir              = "pgdelta"
	migrationsCatalogName       = "catalog-%s-migrations-%s-%d.json"
	legacyMigrationsCatalogName = "catalog-%s-migrations-%s.json"
	catalogRetentionCount       = 2
)

var catalogPrefixRegexp = regexp.MustCompile(`[^a-zA-Z0-9._-]+`)

func MigrationCatalogPath(hash, prefix string, createdAt time.Time) string {
	return filepath.Join(pgDeltaTempPath(), fmt.Sprintf(migrationsCatalogName, SanitizedCatalogPrefix(prefix), hash, createdAt.UnixMilli()))
}

func ResolveMigrationCatalogPath(fsys afero.Fs, hash, prefix string) (string, bool, error) {
	if err := ensureTempDir(fsys); err != nil {
		return "", false, err
	}
	entries, err := afero.ReadDir(fsys, pgDeltaTempPath())
	if err != nil {
		return "", false, err
	}
	familyPrefix := fmt.Sprintf("catalog-%s-migrations-%s-", SanitizedCatalogPrefix(prefix), hash)
	legacyName := fmt.Sprintf(legacyMigrationsCatalogName, SanitizedCatalogPrefix(prefix), hash)
	latestPath := ""
	latestTimestamp := int64(-1)
	for _, entry := range entries {
		name := entry.Name()
		if strings.HasPrefix(name, familyPrefix) && strings.HasSuffix(name, ".json") {
			stamp := strings.TrimSuffix(strings.TrimPrefix(name, familyPrefix), ".json")
			ts, err := strconv.ParseInt(stamp, 10, 64)
			if err != nil {
				continue
			}
			if ts > latestTimestamp {
				latestTimestamp = ts
				latestPath = filepath.Join(pgDeltaTempPath(), name)
			}
		}
	}
	if latestTimestamp >= 0 {
		return latestPath, true, nil
	}
	legacyPath := filepath.Join(pgDeltaTempPath(), legacyName)
	if ok, err := afero.Exists(fsys, legacyPath); err != nil {
		return "", false, err
	} else if ok {
		return legacyPath, true, nil
	}
	return "", false, nil
}

func WriteMigrationCatalogSnapshot(fsys afero.Fs, prefix, hash, snapshot string) (string, error) {
	if err := ensureTempDir(fsys); err != nil {
		return "", err
	}
	path := MigrationCatalogPath(hash, prefix, time.Now().UTC())
	if err := utils.WriteFile(path, []byte(snapshot), fsys); err != nil {
		return "", err
	}
	if err := CleanupOldMigrationCatalogs(fsys, prefix); err != nil {
		return "", err
	}
	return path, nil
}

func CleanupOldMigrationCatalogs(fsys afero.Fs, prefix string) error {
	if err := ensureTempDir(fsys); err != nil {
		return err
	}
	entries, err := afero.ReadDir(fsys, pgDeltaTempPath())
	if err != nil {
		return err
	}
	keepPrefix := SanitizedCatalogPrefix(prefix)
	familyPrefix := fmt.Sprintf("catalog-%s-migrations-", keepPrefix)
	type catalogFile struct {
		name      string
		timestamp int64
	}
	var files []catalogFile
	for _, entry := range entries {
		name := entry.Name()
		if !strings.HasPrefix(name, familyPrefix) || !strings.HasSuffix(name, ".json") {
			continue
		}
		if ts, ok := migrationCatalogTimestamp(name); ok {
			files = append(files, catalogFile{name: name, timestamp: ts})
			continue
		}
		files = append(files, catalogFile{name: name, timestamp: 0})
	}
	sort.Slice(files, func(i, j int) bool {
		if files[i].timestamp == files[j].timestamp {
			return files[i].name > files[j].name
		}
		return files[i].timestamp > files[j].timestamp
	})
	for i := catalogRetentionCount; i < len(files); i++ {
		if err := fsys.Remove(filepath.Join(pgDeltaTempPath(), files[i].name)); err != nil {
			return err
		}
	}
	return nil
}

func migrationCatalogTimestamp(name string) (int64, bool) {
	if !strings.HasSuffix(name, ".json") {
		return 0, false
	}
	raw := strings.TrimSuffix(name, ".json")
	idx := strings.LastIndex(raw, "-")
	if idx < 0 || idx+1 >= len(raw) {
		return 0, false
	}
	ts, err := strconv.ParseInt(raw[idx+1:], 10, 64)
	if err != nil {
		return 0, false
	}
	return ts, true
}

func HashMigrations(fsys afero.Fs) (string, error) {
	migrations, err := migration.ListLocalMigrations(utils.MigrationsDir, afero.NewIOFS(fsys))
	if err != nil {
		return "", err
	}
	h := sha256.New()
	for _, fp := range migrations {
		contents, err := afero.ReadFile(fsys, fp)
		if err != nil {
			return "", err
		}
		if _, err := h.Write([]byte(fp)); err != nil {
			return "", err
		}
		if _, err := h.Write(contents); err != nil {
			return "", err
		}
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

func SanitizedCatalogPrefix(prefix string) string {
	prefix = strings.TrimSpace(prefix)
	if len(prefix) == 0 {
		return "local"
	}
	return catalogPrefixRegexp.ReplaceAllString(prefix, "-")
}

func ensureTempDir(fsys afero.Fs) error {
	return utils.MkdirIfNotExistFS(fsys, pgDeltaTempPath())
}

func pgDeltaTempPath() string {
	return filepath.Join(utils.TempDir, pgDeltaTempDir)
}
