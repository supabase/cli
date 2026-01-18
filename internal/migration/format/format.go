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
		// Cluster level entities
		case *ast.CreateRoleStmt, *ast.AlterRoleStmt, *ast.AlterRoleSetStmt, *ast.GrantRoleStmt:
			name = utils.RolesPath
		case *ast.CreateExtensionStmt, *ast.AlterExtensionStmt, *ast.AlterExtensionContentsStmt:
			name = utils.ExtensionsPath
		case *ast.CreateFdwStmt, *ast.AlterFdwStmt, *ast.CreateForeignServerStmt, *ast.AlterForeignServerStmt, *ast.CreateUserMappingStmt, *ast.AlterUserMappingStmt:
			name = utils.ForeignDWPath
		case *ast.CreatePublicationStmt, *ast.AlterPublicationStmt:
			name = utils.PublicationsPath
		case *ast.CreateSubscriptionStmt, *ast.AlterSubscriptionStmt:
			name = utils.SubscriptionsPath
		case *ast.CreateEventTrigStmt, *ast.AlterEventTrigStmt:
			name = utils.EventTriggersPath
		case *ast.CreateTableSpaceStmt, *ast.AlterTableSpaceStmt:
			name = utils.TablespacesPath
		case *ast.AlterDatabaseStmt, *ast.AlterDatabaseSetStmt, *ast.AlterSystemStmt, *ast.VariableSetStmt:
			name = utils.VariablesPath
		// Schema level entities
		case *ast.CreateSchemaStmt:
			name = getSchemaPath(v.Schemaname)
		case *ast.CreateOpFamilyStmt:
			if s := getQualifiedSchema(v.OpFamilyName); s != nil {
				name = getSchemaPath(s.SVal)
			}
		case *ast.AlterOpFamilyStmt:
			if s := getQualifiedSchema(v.OpFamilyName); s != nil {
				name = getSchemaPath(s.SVal)
			}
		case *ast.AlterCollationStmt:
			if s := getQualifiedSchema(v.Collname); s != nil {
				name = getSchemaPath(s.SVal)
			}
		case *ast.AlterTSDictionaryStmt:
			if s := getQualifiedSchema(v.Dictname); s != nil {
				name = getSchemaPath(s.SVal)
			}
		case *ast.AlterTSConfigurationStmt:
			if s := getQualifiedSchema(v.Cfgname); s != nil {
				name = getSchemaPath(s.SVal)
			}
		// Schema level entities - types
		case *ast.CompositeTypeStmt:
			if r := v.Typevar; r != nil && len(r.SchemaName) > 0 {
				name = getTypesPath(r.SchemaName)
			}
		case *ast.AlterCompositeTypeStmt:
			if s := getQualifiedSchema(v.TypeName); s != nil {
				name = getTypesPath(s.SVal)
			}
		case *ast.AlterTypeStmt:
			if s := getQualifiedSchema(v.TypeName); s != nil {
				name = getTypesPath(s.SVal)
			}
		case *ast.CreateEnumStmt:
			if s := getQualifiedSchema(v.TypeName); s != nil {
				name = getTypesPath(s.SVal)
			}
		case *ast.AlterEnumStmt:
			if s := getQualifiedSchema(v.TypeName); s != nil {
				name = getTypesPath(s.SVal)
			}
		case *ast.CreateRangeStmt:
			if s := getQualifiedSchema(v.TypeName); s != nil {
				name = getTypesPath(s.SVal)
			}
		case *ast.CreateTransformStmt:
			if t := v.TypeName; t != nil {
				if s := getQualifiedSchema(t.Names); s != nil {
					name = getTypesPath(s.SVal)
				}
			}
		case *ast.CreateDomainStmt:
			if s := getQualifiedSchema(v.Domainname); s != nil {
				name = getTypesPath(s.SVal)
			}
		case *ast.AlterDomainStmt:
			if s := getQualifiedSchema(v.TypeName); s != nil {
				name = getTypesPath(s.SVal)
			}
		case *ast.CreateOpClassStmt:
			if t := v.DataType; t != nil {
				if s := getQualifiedSchema(t.Names); s != nil {
					name = getTypesPath(s.SVal)
				}
			}
		case *ast.DefineStmt:
			if s := getQualifiedSchema(v.DefNames); s != nil {
				name = getTypesPath(s.SVal)
			}
		// Schema level entities - relations
		case *ast.CreateStmt:
			if r := v.Relation; r != nil && len(r.SchemaName) > 0 {
				name = getTablePath(r.SchemaName, r.RelName)
			}
		case *ast.AlterTableStmt:
			if r := v.Relation; r != nil && len(r.SchemaName) > 0 {
				name = getTablePath(r.SchemaName, r.RelName)
			}
		case *ast.CreateForeignTableStmt:
			if t := v.Base; t != nil {
				if r := t.Relation; r != nil && len(r.SchemaName) > 0 {
					name = getForeignTablePath(r.SchemaName, r.RelName)
				}
			}
		case *ast.CreateTableAsStmt:
			if t := v.Into; t != nil {
				if r := t.Rel; r != nil && len(r.SchemaName) > 0 {
					name = getMaterializedViewPath(r.SchemaName, r.RelName)
				}
			}
		case *ast.ViewStmt:
			if r := v.View; r != nil && len(r.SchemaName) > 0 {
				name = getViewPath(r.SchemaName, r.RelName)
			}
		case *ast.CreateSeqStmt:
			if r := v.Sequence; r != nil && len(r.SchemaName) > 0 {
				name = getSequencesPath(r.SchemaName)
			}
		case *ast.AlterSeqStmt:
			if r := v.Sequence; r != nil && len(r.SchemaName) > 0 {
				name = getSequencesPath(r.SchemaName)
			}
		case *ast.IndexStmt:
			if r := v.Relation; r != nil && len(r.SchemaName) > 0 {
				name = getTablePath(r.SchemaName, r.RelName)
			}
		case *ast.CreatePolicyStmt:
			if r := v.Table; r != nil && len(r.SchemaName) > 0 {
				name = getTablePath(r.SchemaName, r.RelName)
			}
		case *ast.AlterPolicyStmt:
			if r := v.Table; r != nil && len(r.SchemaName) > 0 {
				name = getTablePath(r.SchemaName, r.RelName)
			}
		case *ast.RuleStmt:
			if r := v.Relation; r != nil && len(r.SchemaName) > 0 {
				name = getTablePath(r.SchemaName, r.RelName)
			}
		// Schema level entities - functions
		case *ast.CreateFunctionStmt:
			if s := toQualifiedName(v.FuncName); len(s) == 2 {
				name = getFunctionPath(s[0], s[1])
			}
		case *ast.AlterFunctionStmt:
			if f := v.Func; f != nil {
				if s := toQualifiedName(f.Objname); len(s) == 2 {
					name = getFunctionPath(s[0], s[1])
				}
			}
		case *ast.CreateTriggerStmt:
			if s := toQualifiedName(v.Funcname); len(s) == 2 {
				name = getFunctionPath(s[0], s[1])
			}
		case *ast.CreatePLangStmt:
			if s := toQualifiedName(v.PLHandler); len(s) == 2 {
				name = getFunctionPath(s[0], s[1])
			}
		case *ast.CreateAmStmt:
			if s := toQualifiedName(v.HandlerName); len(s) == 2 {
				name = getFunctionPath(s[0], s[1])
			}
		// Schema level entities - others
		case *ast.CommentStmt:
			if s := getNodePath(v.Objtype, v.Object); len(s) > 0 {
				name = s
			}
		case *ast.AlterOwnerStmt:
			if s := getNodePath(v.ObjectType, v.Object); len(s) > 0 {
				name = s
			}
		case *ast.GrantStmt:
			if n := v.Objects; n != nil && len(n.Items) == 1 {
				if s := getNodePath(v.Objtype, n.Items[0]); len(s) > 0 {
					name = s
				}
			}
		case *ast.AlterDefaultPrivilegesStmt:
			if n := v.Options; n != nil {
				for _, s := range n.Items {
					if e, ok := s.(*ast.DefElem); ok && e.Defname == "schemas" {
						if n, ok := e.Arg.(*ast.NodeList); ok && len(n.Items) == 1 {
							if p, ok := n.Items[0].(*ast.String); ok {
								name = getPrivilegesPath(p.SVal)
							}
						}
					}
				}
			}
		// TODO: Data level entities, ie. pg_cron, pgmq, etc.
		case *ast.InsertStmt, *ast.UpdateStmt, *ast.DeleteStmt, *ast.CopyStmt, *ast.CallStmt, *ast.SelectStmt:
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

func getNodePath(obj ast.ObjectType, n ast.Node) string {
	switch obj {
	case ast.OBJECT_ACCESS_METHOD:
	case ast.OBJECT_AGGREGATE:
	// case ast.OBJECT_AMOP:
	// case ast.OBJECT_AMPROC:
	// case ast.OBJECT_ATTRIBUTE:
	// case ast.OBJECT_CAST:
	case ast.OBJECT_COLUMN:
	case ast.OBJECT_COLLATION:
	// case ast.OBJECT_CONVERSION:
	// case ast.OBJECT_DATABASE:
	// case ast.OBJECT_DEFAULT:
	// case ast.OBJECT_DEFACL:
	case ast.OBJECT_DOMAIN:
	// case ast.OBJECT_DOMCONSTRAINT:
	case ast.OBJECT_EVENT_TRIGGER:
		return utils.EventTriggersPath
	case ast.OBJECT_EXTENSION:
		return utils.ExtensionsPath
	case ast.OBJECT_FDW:
		return utils.ForeignDWPath
	case ast.OBJECT_FOREIGN_SERVER:
		return utils.ForeignDWPath
	case ast.OBJECT_FOREIGN_TABLE:
	case ast.OBJECT_FUNCTION:
	case ast.OBJECT_INDEX:
	// case ast.OBJECT_LANGUAGE:
	// case ast.OBJECT_LARGEOBJECT:
	case ast.OBJECT_MATVIEW:
	// case ast.OBJECT_OPCLASS:
	// case ast.OBJECT_OPERATOR:
	// case ast.OBJECT_OPFAMILY:
	// case ast.OBJECT_PARAMETER_ACL:
	case ast.OBJECT_POLICY:
	case ast.OBJECT_PROCEDURE:
	case ast.OBJECT_PUBLICATION:
		return utils.PublicationsPath
	case ast.OBJECT_PUBLICATION_NAMESPACE:
	case ast.OBJECT_PUBLICATION_REL:
	case ast.OBJECT_ROLE:
	case ast.OBJECT_ROUTINE:
	case ast.OBJECT_RULE:
	case ast.OBJECT_SCHEMA:
		if s, ok := n.(*ast.String); ok {
			return getSchemaPath(s.SVal)
		}
	case ast.OBJECT_SEQUENCE:
		if nl, ok := n.(*ast.NodeList); ok {
			if s := toQualifiedName(nl); len(s) == 2 {
				return getTablePath(s[0], s[1])
			}
		} else if s, ok := n.(*ast.RangeVar); ok {
			return getSequencesPath(s.SchemaName)
		}
	case ast.OBJECT_SUBSCRIPTION:
		return utils.SubscriptionsPath
	// case ast.OBJECT_STATISTIC_EXT:
	// case ast.OBJECT_TABCONSTRAINT:
	case ast.OBJECT_TABLE:
		if nl, ok := n.(*ast.NodeList); ok {
			if s := toQualifiedName(nl); len(s) == 2 {
				return getTablePath(s[0], s[1])
			}
		} else if r, ok := n.(*ast.RangeVar); ok && len(r.SchemaName) > 0 {
			return getTablePath(r.SchemaName, r.RelName)
		}
	case ast.OBJECT_TABLESPACE:
	case ast.OBJECT_TRANSFORM:
	case ast.OBJECT_TRIGGER:
	case ast.OBJECT_TSCONFIGURATION:
	case ast.OBJECT_TSDICTIONARY:
	// case ast.OBJECT_TSPARSER:
	// case ast.OBJECT_TSTEMPLATE:
	case ast.OBJECT_TYPE:
		if nl, ok := n.(*ast.NodeList); ok && len(nl.Items) == 2 {
			if s, ok := nl.Items[0].(*ast.String); ok {
				return getTypesPath(s.SVal)
			}
		}
	case ast.OBJECT_USER_MAPPING:
	case ast.OBJECT_VIEW:
	}
	return ""
}

func getQualifiedSchema(n *ast.NodeList) *ast.String {
	if n != nil && len(n.Items) == 2 {
		if s, ok := n.Items[0].(*ast.String); ok {
			return s
		}
	}
	return nil
}

func toQualifiedName(n *ast.NodeList) []string {
	if n == nil {
		return nil
	}
	var r []string
	for _, v := range n.Items {
		if s, ok := v.(*ast.String); ok {
			r = append(r, s.SVal)
		}
	}
	return r
}

func getSchemaPath(name string) string {
	return filepath.Join(utils.SchemasDir, name, "schema.sql")
}

func getTypesPath(schema string) string {
	return filepath.Join(utils.SchemasDir, schema, "types.sql")
}

func getSequencesPath(schema string) string {
	return filepath.Join(utils.SchemasDir, schema, "sequences.sql")
}

func getPrivilegesPath(schema string) string {
	return filepath.Join(utils.SchemasDir, schema, "privileges.sql")
}

func getTablePath(schema, name string) string {
	return filepath.Join(utils.SchemasDir, schema, "tables", name+".sql")
}

func getForeignTablePath(schema, name string) string {
	return filepath.Join(utils.SchemasDir, schema, "foreign_tables", name+".sql")
}

func getFunctionPath(schema, name string) string {
	return filepath.Join(utils.SchemasDir, schema, "functions", name+".sql")
}

func getMaterializedViewPath(schema, name string) string {
	return filepath.Join(utils.SchemasDir, schema, "materialized_views", name+".sql")
}

func getViewPath(schema, name string) string {
	return filepath.Join(utils.SchemasDir, schema, "views", name+".sql")
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
