package format

import (
	"context"
	_ "embed"
	"fmt"
	"os"
	"path/filepath"

	"github.com/go-errors/errors"
	"github.com/multigres/multigres/go/parser"
	"github.com/multigres/multigres/go/parser/ast"
	"github.com/spf13/afero"
	"github.com/supabase/cli/internal/utils"
)

//go:embed templates/order.toml
var order string

func WriteStructuredSchemas(ctx context.Context, sql string, fsys afero.Fs) error {
	stat, err := parser.ParseSQL(sql)
	if err != nil {
		return errors.Errorf("failed to parse SQL: %w", err)
	}
	for _, d := range []string{utils.ClusterDir, utils.SchemasDir, utils.DataDir} {
		if err := fsys.RemoveAll(d); err != nil {
			return errors.Errorf("failed to remove directory: %w", err)
		}
	}
	for _, s := range stat {
		name := utils.UnqualifiedPath
		switch v := s.(type) {
		case *ast.VariableSetStmt:
			name = utils.VariablesPath
		case *ast.SelectStmt:
			if n := v.TargetList; n != nil && len(n.Items) == 1 {
				fmt.Fprintln(os.Stderr, n.Items[0].String())
			}
			// TODO: differentiate function calls to create cron / pgmq / etc
			name = utils.CronPath
		case *ast.CreateExtensionStmt:
			name = utils.ExtensionsPath
		case *ast.CreateSchemaStmt:
			name = filepath.Join(utils.SchemasDir, v.Schemaname, "schema.sql")
		case *ast.CommentStmt:
			switch v.Objtype {
			case ast.OBJECT_SCHEMA:
				if s, ok := v.Object.(*ast.String); ok {
					name = filepath.Join(utils.SchemasDir, s.SVal, "schema.sql")
				}
			case ast.OBJECT_TABLE:
				if n, ok := v.Object.(*ast.NodeList); ok && len(n.Items) == 2 {
					if s0, ok := n.Items[0].(*ast.String); !ok {
						break
					} else if s1, ok := n.Items[1].(*ast.String); !ok {
						break
					} else {
						name = filepath.Join(utils.SchemasDir, s0.SVal, "tables", s1.SVal+".sql")
					}
				}
			}
		case *ast.CompositeTypeStmt:
			if r := v.Typevar; r != nil && len(r.SchemaName) > 0 {
				name = filepath.Join(utils.SchemasDir, r.SchemaName, "types.sql")
			}
		case *ast.CreateEnumStmt:
			if n := v.TypeName; n != nil && len(n.Items) == 2 {
				if s, ok := n.Items[0].(*ast.String); ok {
					name = filepath.Join(utils.SchemasDir, s.SVal, "types.sql")
				}
			}
		case *ast.AlterOwnerStmt:
			switch v.ObjectType {
			case ast.OBJECT_TYPE:
				if n, ok := v.Object.(*ast.NodeList); ok && len(n.Items) == 2 {
					if s, ok := n.Items[0].(*ast.String); ok {
						name = filepath.Join(utils.SchemasDir, s.SVal, "types.sql")
					}
				}
			case ast.OBJECT_TABLE:
				name = utils.TablePath
			case ast.OBJECT_PUBLICATION:
				name = utils.PublicationsPath
			case ast.OBJECT_SCHEMA:
				if s, ok := v.Object.(*ast.String); ok {
					name = filepath.Join(utils.SchemasDir, s.SVal, "schema.sql")
				}
			}
		case *ast.CreateStmt:
			name = getTablePath(v.Relation)
		case *ast.AlterTableStmt:
			name = getTablePath(v.Relation)
		case *ast.GrantStmt:
			switch v.Objtype {
			case ast.OBJECT_SCHEMA:
				if n := v.Objects; n != nil && len(n.Items) == 1 {
					if s, ok := n.Items[0].(*ast.String); ok {
						name = filepath.Join(utils.SchemasDir, s.SVal, "schema.sql")
					}
				}
			case ast.OBJECT_TABLE:
				if n := v.Objects; n != nil && len(n.Items) == 1 {
					if s, ok := n.Items[0].(*ast.RangeVar); ok {
						name = getTablePath(s)
					}
				}
			case ast.OBJECT_SEQUENCE:
				if n := v.Objects; n != nil && len(n.Items) == 1 {
					if s, ok := n.Items[0].(*ast.RangeVar); ok {
						name = filepath.Join(utils.SchemasDir, s.SchemaName, "sequences.sql")
					}
				}
			}
		case *ast.AlterDefaultPrivilegesStmt:
			name = utils.PrivilegesPath
		}
		if name == utils.UnqualifiedPath {
			fmt.Fprintln(os.Stderr, "Unsupported:", s.SqlString())
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

func getTablePath(r *ast.RangeVar) string {
	if r != nil && len(r.SchemaName) > 0 {
		return filepath.Join(utils.SchemasDir, r.SchemaName, "tables", r.RelName+".sql")
	}
	return utils.TablePath
}

func appendFile(name, data string, fsys afero.Fs) error {
	if err := utils.MkdirIfNotExistFS(fsys, filepath.Dir(name)); err != nil {
		return err
	}
	f, err := fsys.OpenFile(name, os.O_WRONLY|os.O_CREATE|os.O_APPEND, 0644)
	if err != nil {
		return errors.Errorf("failed to open file: %w", err)
	}
	defer f.Close()
	if _, err := f.WriteString(data); err != nil {
		return errors.Errorf("failed to write file: %w", err)
	}
	return nil
}
