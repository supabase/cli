package format

import (
	"bytes"
	"context"
	_ "embed"
	"fmt"
	"io"
	"os"
	"path/filepath"

	"github.com/go-errors/errors"
	"github.com/multigres/multigres/go/parser"
	"github.com/multigres/multigres/go/parser/ast"
	"github.com/spf13/afero"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/pkg/migration"
)

//go:embed templates/order.toml
var order string

func Run(ctx context.Context, fsys afero.Fs) error {
	files, err := migration.ListLocalMigrations(utils.MigrationsDir, afero.NewIOFS(fsys))
	if err != nil {
		return err
	}
	var buf bytes.Buffer
	for _, name := range files {
		if err := readFile(name, &buf, fsys); err != nil {
			return err
		}
	}
	stat, err := parser.ParseSQL(buf.String())
	if err != nil {
		return errors.Errorf("failed to parse SQL: %w", err)
	}
	for _, d := range []string{utils.ClusterDir, utils.SchemasDir, utils.DataDir} {
		if err := fsys.RemoveAll(d); err != nil {
			return errors.Errorf("failed to remove directory: %w", err)
		}
	}
	for _, s := range stat {
		var name string
		switch v := s.(type) {
		case *ast.VariableSetStmt:
			name = utils.VariablesPath
		case *ast.SelectStmt:
			fmt.Fprintln(os.Stderr, v.TargetList)
			// TODO: differentiate function calls to create cron / pgmq / etc
			name = utils.CronPath
		case *ast.CreateExtensionStmt:
			name = utils.ExtensionsPath
		case *ast.CommentStmt:
			switch v.Objtype {
			case ast.OBJECT_SCHEMA:
				name = utils.SchemaPath
			default:
				name = utils.ExtensionsPath
			}
		case *ast.CreateEnumStmt:
			name = utils.TypePath
		case *ast.AlterOwnerStmt:
			switch v.ObjectType {
			case ast.OBJECT_TYPE:
				name = utils.TypePath
			case ast.OBJECT_TABLE:
				name = utils.TablePath
			case ast.OBJECT_PUBLICATION:
				name = utils.PublicationsPath
			default:
				name = utils.PrivilegesPath
			}
		case *ast.CreateStmt:
			name = utils.TablePath
		case *ast.AlterTableStmt:
			name = utils.TablePath
		case *ast.GrantStmt:
			name = utils.PrivilegesPath
		case *ast.AlterDefaultPrivilegesStmt:
			name = utils.PrivilegesPath
		default:
			fmt.Fprintln(os.Stderr, "Unsupported:", s.SqlString())
			continue
		}
		if err := appendFile(name, s.SqlString()+";\n", fsys); err != nil {
			return err
		}
	}
	if len(utils.Config.Db.Migrations.SchemaPaths) == 0 {
		return appendFile(utils.ConfigPath, order, fsys)
	}
	return nil
}

func readFile(name string, w io.Writer, fsys afero.Fs) error {
	f, err := fsys.Open(name)
	if err != nil {
		return errors.Errorf("failed to open migration: %w", err)
	}
	defer f.Close()
	if _, err := io.Copy(w, f); err != nil {
		return errors.Errorf("failed to read migration: %w", err)
	}
	return nil
}

func appendFile(name, data string, fsys afero.Fs) error {
	if err := utils.MkdirIfNotExistFS(fsys, filepath.Dir(name)); err != nil {
		return err
	}
	f, err := fsys.OpenFile(name, os.O_WRONLY|os.O_CREATE|os.O_APPEND, 0644)
	if err != nil {
		return errors.Errorf("failed to open migration file: %w", err)
	}
	defer f.Close()
	if _, err := f.WriteString(data); err != nil {
		return errors.Errorf("failed to write migration file: %w", err)
	}
	return nil
}
