package pgcache

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/go-errors/errors"
	"github.com/jackc/pgconn"
	"github.com/jackc/pgx/v4"
	"github.com/spf13/afero"
	"github.com/spf13/viper"
	"github.com/supabase/cli/internal/gen/types"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/pkg/migration"
)

const (
	pgDeltaTempDir              = "pgdelta"
	migrationsCatalogName       = "catalog-%s-migrations-%s-%d.json"
	legacyMigrationsCatalogName = "catalog-%s-migrations-%s.json"
	catalogRetentionCount       = 2
	pgDeltaCatalogExportTS      = `// This script serializes a database catalog for caching/reuse in declarative
// pg-delta workflows. Uses the same API as pgdelta_catalog_export.ts (main package only, no /catalog subpath).
import {
  createManagedPool,
  extractCatalog,
  serializeCatalog,
  stringifyCatalogSnapshot,
} from "npm:@supabase/pg-delta@1.0.0-alpha.20";
const target = Deno.env.get("TARGET");
const role = Deno.env.get("ROLE") ?? undefined;
if (!target) {
  console.error("TARGET is required");
  throw new Error("");
}
const { pool, close } = await createManagedPool(target, { role });
try {
  const catalog = await extractCatalog(pool);
  console.log(stringifyCatalogSnapshot(serializeCatalog(catalog)));
} catch (e) {
  console.error(e);
  throw new Error("");
} finally {
  await close();
}
`
)

var catalogPrefixRegexp = regexp.MustCompile(`[^a-zA-Z0-9._-]+`)

func TryCacheMigrationsCatalog(ctx context.Context, config pgconn.Config, prefix string, version string, fsys afero.Fs, options ...func(*pgx.ConnConfig)) error {
	if !ShouldCacheMigrationsCatalog() || len(version) > 0 {
		return nil
	}
	if len(strings.TrimSpace(prefix)) == 0 {
		prefix = CatalogPrefixFromConfig(config)
	}
	hash, err := HashMigrations(fsys)
	if err != nil {
		return err
	}
	snapshot, err := exportCatalog(ctx, utils.ToPostgresURL(config), options...)
	if err != nil {
		return err
	}
	if err := ensureTempDir(fsys); err != nil {
		return err
	}
	_, err = WriteMigrationCatalogSnapshot(fsys, prefix, hash, snapshot)
	return err
}

func ShouldCacheMigrationsCatalog() bool {
	return utils.IsPgDeltaEnabled() || viper.GetBool("EXPERIMENTAL_PG_DELTA")
}

func CatalogPrefixFromConfig(config pgconn.Config) string {
	if utils.IsLocalDatabase(config) {
		return "local"
	}
	if matches := utils.ProjectHostPattern.FindStringSubmatch(config.Host); len(matches) > 2 {
		return matches[2]
	}
	key := fmt.Sprintf("%s@%s:%d/%s", config.User, config.Host, config.Port, config.Database)
	sum := sha256.Sum256([]byte(key))
	return "url-" + hex.EncodeToString(sum[:])[:12]
}

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

func exportCatalog(ctx context.Context, targetRef string, options ...func(*pgx.ConnConfig)) (string, error) {
	env := []string{"TARGET=" + targetRef, "ROLE=postgres"}
	if ca, err := types.GetRootCA(ctx, targetRef, options...); err != nil {
		return "", err
	} else if len(ca) > 0 {
		env = append(env, "PGDELTA_TARGET_SSLROOTCERT="+ca)
	}
	binds := []string{utils.EdgeRuntimeId + ":/root/.cache/deno:rw"}
	var stdout, stderr bytes.Buffer
	if err := utils.RunEdgeRuntimeScript(ctx, env, pgDeltaCatalogExportTS, binds, "error exporting pg-delta catalog", &stdout, &stderr); err != nil {
		return "", err
	}
	snapshot := strings.TrimSpace(stdout.String())
	if len(snapshot) == 0 {
		return "", errors.Errorf("error exporting pg-delta catalog: edge-runtime script produced no output:\n%s", stderr.String())
	}
	return snapshot, nil
}
