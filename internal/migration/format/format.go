package format

import (
	"bytes"
	"context"
	_ "embed"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/go-errors/errors"
	mg "github.com/multigres/multigres/go/parser"
	"github.com/multigres/multigres/go/parser/ast"
	"github.com/spf13/afero"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/pkg/parser"
)

var (
	rolesPath         = filepath.Join(utils.ClusterDir, "roles.sql")
	extensionsPath    = filepath.Join(utils.ClusterDir, "extensions.sql")
	foreignDWPath     = filepath.Join(utils.ClusterDir, "foreign_data_wrappers.sql")
	publicationsPath  = filepath.Join(utils.ClusterDir, "publications.sql")
	subscriptionsPath = filepath.Join(utils.ClusterDir, "subscriptions.sql")
	eventTriggersPath = filepath.Join(utils.ClusterDir, "event_triggers.sql")
	tablespacesPath   = filepath.Join(utils.ClusterDir, "tablespaces.sql")
	variablesPath     = filepath.Join(utils.ClusterDir, "variables.sql")
	unqualifiedPath   = filepath.Join(utils.SchemasDir, "unqualified.sql")
)

func getSchemaPath(name string) string {
	return filepath.Join(utils.SchemasDir, name, "schema.sql")
}

func getTypesPath(schema string) string {
	return filepath.Join(utils.SchemasDir, schema, "types.sql")
}

func getSequencesPath(schema string) string {
	return filepath.Join(utils.SchemasDir, schema, "sequences.sql")
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

func getProcedurePath(schema, name string) string {
	return filepath.Join(utils.SchemasDir, schema, "procedures", name+".sql")
}

func getMaterializedViewPath(schema, name string) string {
	return filepath.Join(utils.SchemasDir, schema, "materialized_views", name+".sql")
}

func getViewPath(schema, name string) string {
	return filepath.Join(utils.SchemasDir, schema, "views", name+".sql")
}

func getPolicyPath(schema, name string) string {
	return filepath.Join(utils.SchemasDir, schema, "policies", name+".sql")
}

func getDomainPath(schema, name string) string {
	return filepath.Join(utils.SchemasDir, schema, "domains", name+".sql")
}

func getOperatorPath(schema, name string) string {
	return filepath.Join(utils.SchemasDir, schema, "operators", name+".sql")
}

func getSequenceOrTablePath(schema, name string, seen map[string]string) string {
	keys := []string{fmt.Sprintf("%s.%s.%s", ast.OBJECT_SEQUENCE, schema, name)}
	// Find sequences that were created implicitly with tables
	parts := strings.Split(name, "_")
	for i := len(parts) - 2; i > 0; i-- {
		table := strings.Join(parts[:i], "_")
		keys = append(keys, fmt.Sprintf("%s.%s.%s", ast.OBJECT_TABLE, schema, table))
	}
	for _, k := range keys {
		if fp, found := seen[k]; found {
			return fp
		}
	}
	// Tables may be renamed such that its sequence id doesn't contain the table name
	return getSequencesPath(schema)
}

func WriteStructuredSchemas(ctx context.Context, sql io.Reader, fsys afero.Fs) error {
	stat, err := parser.Split(sql, strings.TrimSpace)
	if err != nil {
		return err
	}
	for _, d := range []string{utils.ClusterDir, utils.SchemasDir} {
		if err := fsys.RemoveAll(d); err != nil {
			return errors.Errorf("failed to remove directory: %w", err)
		}
	}
	schemaPaths := []string{
		variablesPath,
		rolesPath,
		extensionsPath,
		foreignDWPath,
		tablespacesPath,
	}
	// Holds entities that depend on others but can be referenced directly by id
	// Or those with ambiguous keywords like table / view, etc.
	nodeToPath := map[string]string{}
	for _, line := range stat {
		name := unqualifiedPath
		parsed, err := mg.ParseSQL(line)
		if err != nil {
			return errors.Errorf("failed to parse SQL: %w", err)
		} else if len(parsed) == 0 {
			continue
		}
		switch v := parsed[0].(type) {
		// Cluster level entities
		case *ast.CreateRoleStmt, *ast.AlterRoleStmt, *ast.AlterRoleSetStmt, *ast.GrantRoleStmt:
			name = rolesPath
		case *ast.CreateExtensionStmt, *ast.AlterExtensionStmt, *ast.AlterExtensionContentsStmt:
			name = extensionsPath
		case *ast.CreateFdwStmt, *ast.AlterFdwStmt, *ast.CreateForeignServerStmt, *ast.AlterForeignServerStmt, *ast.CreateUserMappingStmt, *ast.AlterUserMappingStmt:
			name = foreignDWPath
		case *ast.CreatePublicationStmt, *ast.AlterPublicationStmt:
			name = publicationsPath
		case *ast.CreateSubscriptionStmt, *ast.AlterSubscriptionStmt:
			name = subscriptionsPath
		case *ast.CreateEventTrigStmt, *ast.AlterEventTrigStmt:
			name = eventTriggersPath
		case *ast.CreateTableSpaceStmt, *ast.AlterTableSpaceStmt:
			name = tablespacesPath
		case *ast.CreatedbStmt, *ast.AlterDatabaseStmt, *ast.AlterDatabaseSetStmt, *ast.AlterSystemStmt, *ast.VariableSetStmt:
			name = variablesPath
		// Schema level entities
		case *ast.CreateSchemaStmt:
			name = getSchemaPath(v.Schemaname)
		case *ast.CreateOpFamilyStmt:
			if s := toQualifiedName(v.OpFamilyName); len(s) == 2 {
				name = getSchemaPath(s[0])
			}
		case *ast.AlterOpFamilyStmt:
			if s := toQualifiedName(v.OpFamilyName); len(s) == 2 {
				name = getSchemaPath(s[0])
			}
		case *ast.AlterCollationStmt:
			if s := toQualifiedName(v.Collname); len(s) == 2 {
				name = getSchemaPath(s[0])
			}
		case *ast.AlterTSDictionaryStmt:
			if s := toQualifiedName(v.Dictname); len(s) == 2 {
				name = getSchemaPath(s[0])
			}
		case *ast.AlterTSConfigurationStmt:
			if s := toQualifiedName(v.Cfgname); len(s) == 2 {
				name = getSchemaPath(s[0])
			}
		// Schema level entities - types
		case *ast.DefineStmt:
			if s := getNodePath(v.Kind, v.DefNames, nodeToPath); len(s) > 0 {
				name = s
			}
		case *ast.AlterTypeStmt:
			if s := toQualifiedName(v.TypeName); len(s) == 2 {
				name = getTypesPath(s[0])
			}
		case *ast.CompositeTypeStmt:
			if r := v.Typevar; r != nil && len(r.SchemaName) > 0 {
				name = getTypesPath(r.SchemaName)
			}
		case *ast.AlterCompositeTypeStmt:
			if s := toQualifiedName(v.TypeName); len(s) == 2 {
				name = getTypesPath(s[0])
			}
		case *ast.CreateEnumStmt:
			if s := toQualifiedName(v.TypeName); len(s) == 2 {
				name = getTypesPath(s[0])
			}
		case *ast.AlterEnumStmt:
			if s := toQualifiedName(v.TypeName); len(s) == 2 {
				name = getTypesPath(s[0])
			}
		case *ast.CreateRangeStmt:
			if s := toQualifiedName(v.TypeName); len(s) == 2 {
				name = getTypesPath(s[0])
			}
		case *ast.CreateTransformStmt:
			if t := v.FromSql; t != nil {
				if s := toQualifiedName(t.Objname); len(s) == 2 {
					name = getOperatorPath(s[0], s[1])
				}
			}
			if t := v.TypeName; t != nil {
				if s := toQualifiedName(t.Names); len(s) == 2 {
					key := fmt.Sprintf("%s.%s.%s", ast.OBJECT_TRANSFORM, s[0], s[1])
					nodeToPath[key] = name
				}
			}
		case *ast.CreateDomainStmt:
			if s := toQualifiedName(v.Domainname); len(s) == 2 {
				name = getDomainPath(s[0], s[1])
			}
		case *ast.AlterDomainStmt:
			if s := toQualifiedName(v.TypeName); len(s) == 2 {
				name = getDomainPath(s[0], s[1])
			}
		// Schema level entities - relations
		case *ast.CreateStmt:
			if r := v.Relation; r != nil && len(r.SchemaName) > 0 {
				name = getTablePath(r.SchemaName, r.RelName)
				key := fmt.Sprintf("%s.%s.%s", ast.OBJECT_TABLE, r.SchemaName, r.RelName)
				nodeToPath[key] = name
			}
		case *ast.AlterTableStmt:
			if r := v.Relation; r != nil && len(r.SchemaName) > 0 {
				name = getTablePath(r.SchemaName, r.RelName)
				// TODO: alter sequence / view owner may be parsed to wrong ast
				switch v.Objtype {
				case ast.OBJECT_SEQUENCE:
					name = getSequenceOrTablePath(r.SchemaName, r.RelName, nodeToPath)
				case ast.OBJECT_VIEW:
					name = getViewPath(r.SchemaName, r.RelName)
				default:
					if c := v.Cmds; c != nil {
						for _, e := range c.Items {
							if t, ok := e.(*ast.AlterTableCmd); ok {
								if n, ok := t.Def.(*ast.Constraint); ok {
									switch n.Contype {
									case ast.CONSTR_FOREIGN:
										name = getPolicyPath(r.SchemaName, r.RelName)
									}
								}
							}
						}
					}
				}
			}
		case *ast.CreateForeignTableStmt:
			if t := v.Base; t != nil {
				if r := t.Relation; r != nil && len(r.SchemaName) > 0 {
					name = getForeignTablePath(r.SchemaName, r.RelName)
					key := fmt.Sprintf("%s.%s.%s", ast.OBJECT_FOREIGN_TABLE, r.SchemaName, r.RelName)
					nodeToPath[key] = name
				}
			}
		case *ast.CreateTableAsStmt:
			if t := v.Into; t != nil {
				if r := t.Rel; r != nil && len(r.SchemaName) > 0 {
					name = getMaterializedViewPath(r.SchemaName, r.RelName)
					key := fmt.Sprintf("%s.%s.%s", ast.OBJECT_MATVIEW, r.SchemaName, r.RelName)
					nodeToPath[key] = name
				}
			}
		case *ast.ViewStmt:
			if r := v.View; r != nil && len(r.SchemaName) > 0 {
				name = getViewPath(r.SchemaName, r.RelName)
				key := fmt.Sprintf("%s.%s.%s", ast.OBJECT_VIEW, r.SchemaName, r.RelName)
				// Adjust for forward declaration of views
				if _, found := nodeToPath[key]; found {
					name = name[:len(name)-4] + "-final.sql"
				}
				nodeToPath[key] = name
			}
		case *ast.CreateSeqStmt:
			if r := v.Sequence; r != nil && len(r.SchemaName) > 0 {
				name = getSequencesPath(r.SchemaName)
				if o := v.Options; o != nil {
					for _, s := range o.Items {
						if e, ok := s.(*ast.DefElem); ok && e.Defname == "owned_by" {
							if n := getQualifiedName(e.Arg); len(n) == 3 {
								name = getTablePath(n[0], n[1])
								key := fmt.Sprintf("%s.%s.%s", ast.OBJECT_SEQUENCE, r.SchemaName, r.RelName)
								nodeToPath[key] = name
							}
						}
					}
				}
			}
		case *ast.AlterSeqStmt:
			if r := v.Sequence; r != nil && len(r.SchemaName) > 0 {
				name = getSequencesPath(r.SchemaName)
				if o := v.Options; o != nil {
					for _, s := range o.Items {
						if e, ok := s.(*ast.DefElem); ok && e.Defname == "owned_by" {
							if n := getQualifiedName(e.Arg); len(n) == 3 {
								name = getTablePath(n[0], n[1])
								key := fmt.Sprintf("%s.%s.%s", ast.OBJECT_SEQUENCE, r.SchemaName, r.RelName)
								nodeToPath[key] = name
							}
						}
					}
				}
			}
		case *ast.IndexStmt:
			if r := v.Relation; r != nil && len(r.SchemaName) > 0 {
				name = getTablePath(r.SchemaName, r.RelName)
			}
			key := fmt.Sprintf("%s.%s", ast.OBJECT_INDEX, v.Idxname)
			nodeToPath[key] = name
		case *ast.CreatePolicyStmt:
			if r := v.Table; r != nil && len(r.SchemaName) > 0 {
				name = getPolicyPath(r.SchemaName, r.RelName)
			}
		case *ast.AlterPolicyStmt:
			if r := v.Table; r != nil && len(r.SchemaName) > 0 {
				name = getPolicyPath(r.SchemaName, r.RelName)
			}
		case *ast.RuleStmt:
			if r := v.Relation; r != nil && len(r.SchemaName) > 0 {
				name = getPolicyPath(r.SchemaName, r.RelName)
			}
		// Schema level entities - functions
		case *ast.CreateFunctionStmt:
			if s := toQualifiedName(v.FuncName); len(s) == 2 {
				if v.IsProcedure {
					name = getProcedurePath(s[0], s[1])
				} else {
					name = getFunctionPath(s[0], s[1])
				}
			}
		case *ast.AlterFunctionStmt:
			if s := getNodePath(v.ObjType, v.Func, nodeToPath); len(s) > 0 {
				name = s
			}
		case *ast.CreateTriggerStmt:
			if r := v.Relation; r != nil && len(r.SchemaName) > 0 {
				name = getPolicyPath(r.SchemaName, r.RelName)
			} else if s := toQualifiedName(v.Funcname); len(s) == 2 {
				name = getFunctionPath(s[0], s[1])
			}
		case *ast.CreatePLangStmt:
			if s := toQualifiedName(v.PLHandler); len(s) == 2 {
				name = getFunctionPath(s[0], s[1])
			}
			key := fmt.Sprintf("%s.%s", ast.OBJECT_LANGUAGE, v.PLName)
			nodeToPath[key] = name
		case *ast.CreateAmStmt:
			if s := toQualifiedName(v.HandlerName); len(s) == 2 {
				name = getFunctionPath(s[0], s[1])
			}
			key := fmt.Sprintf("%s.%s", ast.OBJECT_ACCESS_METHOD, v.AmName)
			nodeToPath[key] = name
		case *ast.CreateConversionStmt:
			if s := toQualifiedName(v.FuncName); len(s) == 2 {
				name = getFunctionPath(s[0], s[1])
			}
		// Schema level entities - operators
		case *ast.CreateOpClassStmt:
			if t := v.DataType; t != nil {
				if s := toQualifiedName(t.Names); len(s) == 2 {
					name = getOperatorPath(s[0], s[1])
				}
			}
		// case *ast.CreateCastStmt:
		case *ast.AlterOperatorStmt:
			if t := v.Opername; t != nil {
				if s := toQualifiedName(t.Objname); len(s) == 2 {
					name = getOperatorPath(s[0], s[1])
				}
			}
		// Schema level entities - others
		case *ast.CommentStmt:
			if s := getNodePath(v.Objtype, v.Object, nodeToPath); len(s) > 0 {
				name = s
			}
		case *ast.AlterOwnerStmt:
			if s := getNodePath(v.ObjectType, v.Object, nodeToPath); len(s) > 0 {
				name = s
			}
		case *ast.GrantStmt:
			if n := v.Objects; n != nil && len(n.Items) == 1 {
				if s := getNodePath(v.Objtype, n.Items[0], nodeToPath); len(s) > 0 {
					name = s
				}
			}
		case *ast.AlterDefaultPrivilegesStmt:
			if o := v.Options; o != nil {
				for _, s := range o.Items {
					if e, ok := s.(*ast.DefElem); ok && e.Defname == "schemas" {
						if n := getQualifiedName(e.Arg); len(n) == 1 {
							name = getSchemaPath(n[0])
						}
					}
				}
			}
		// TODO: Data level entities, ie. pg_cron, pgmq, etc.
		case *ast.InsertStmt, *ast.UpdateStmt, *ast.DeleteStmt, *ast.CopyStmt, *ast.CallStmt, *ast.SelectStmt:
		}
		if name == unqualifiedPath {
			fmt.Fprintf(utils.GetDebugLogger(), "Unqualified (%T): %s\n", parsed[0], line)
		} else if strings.HasPrefix(name, utils.SchemasDir) {
			schemaPaths = append(schemaPaths, name)
			if filepath.Base(name) == "schema.sql" {
				schema := filepath.Base(filepath.Dir(name))
				schemaPaths = append(schemaPaths,
					getTypesPath(schema),
					getSequencesPath(schema),
				)
			}
		}
		if err := appendLine(name, line, fsys); err != nil {
			return err
		}
	}
	schemaPaths = append(schemaPaths,
		unqualifiedPath,
		publicationsPath,
		subscriptionsPath,
		eventTriggersPath,
	)
	utils.Config.Db.Migrations.SchemaPaths = utils.RemoveDuplicates(schemaPaths)
	return appendConfig(fsys)
}

func getNodePath(obj ast.ObjectType, n ast.Node, seen map[string]string) string {
	switch obj {
	case ast.OBJECT_ACCESS_METHOD:
		if s := getQualifiedName(n); len(s) == 1 {
			if fp, found := seen[fmt.Sprintf("%s.%s", obj, s[0])]; found {
				return fp
			}
		}
	case ast.OBJECT_AGGREGATE:
		if s := getQualifiedName(n); len(s) == 2 {
			return getOperatorPath(s[0], s[1])
		}
	case ast.OBJECT_AMOP:
		if s := getQualifiedName(n); len(s) == 1 {
			if fp, found := seen[fmt.Sprintf("%s.%s", obj, s[0])]; found {
				return fp
			}
		}
	case ast.OBJECT_AMPROC:
		if s := getQualifiedName(n); len(s) == 1 {
			if fp, found := seen[fmt.Sprintf("%s.%s", obj, s[0])]; found {
				return fp
			}
		}
	case ast.OBJECT_ATTRIBUTE:
		if s := getQualifiedName(n); len(s) == 2 {
			return getTypesPath(s[0])
		}
	// case ast.OBJECT_CAST:
	case ast.OBJECT_COLUMN:
		if s := getQualifiedName(n); len(s) == 3 {
			return getTablePath(s[0], s[1])
		}
	case ast.OBJECT_COLLATION:
		if s := getQualifiedName(n); len(s) == 2 {
			return getSchemaPath(s[0])
		}
	case ast.OBJECT_CONVERSION:
		if s := getQualifiedName(n); len(s) == 2 {
			return getFunctionPath(s[0], s[1])
		}
	case ast.OBJECT_DATABASE:
		return variablesPath
	case ast.OBJECT_DEFAULT:
		if s := getQualifiedName(n); len(s) == 1 {
			return getSchemaPath(s[0])
		}
	case ast.OBJECT_DEFACL:
		if s := getQualifiedName(n); len(s) == 1 {
			return getSchemaPath(s[0])
		}
	case ast.OBJECT_DOMAIN:
		if s := getQualifiedName(n); len(s) == 2 {
			return getDomainPath(s[0], s[1])
		}
	case ast.OBJECT_DOMCONSTRAINT:
		if s := getQualifiedName(n); len(s) == 3 {
			return getDomainPath(s[0], s[1])
		}
	case ast.OBJECT_EVENT_TRIGGER:
		return eventTriggersPath
	case ast.OBJECT_EXTENSION:
		return extensionsPath
	case ast.OBJECT_FDW:
		return foreignDWPath
	case ast.OBJECT_FOREIGN_SERVER:
		return foreignDWPath
	case ast.OBJECT_FOREIGN_TABLE:
		if s := getQualifiedName(n); len(s) == 2 {
			return getTablePath(s[0], s[1])
		}
	case ast.OBJECT_FUNCTION:
		if s := getQualifiedName(n); len(s) == 2 {
			return getFunctionPath(s[0], s[1])
		}
	case ast.OBJECT_INDEX:
		if s := getQualifiedName(n); len(s) == 1 {
			if fp, found := seen[fmt.Sprintf("%s.%s", obj, s[0])]; found {
				return fp
			}
		}
	case ast.OBJECT_LANGUAGE:
		if s := getQualifiedName(n); len(s) == 1 {
			if fp, found := seen[fmt.Sprintf("%s.%s", obj, s[0])]; found {
				return fp
			}
		}
	// case ast.OBJECT_LARGEOBJECT:
	case ast.OBJECT_MATVIEW:
		if s := getQualifiedName(n); len(s) == 2 {
			return getMaterializedViewPath(s[0], s[1])
		}
	case ast.OBJECT_OPCLASS:
		if s := getQualifiedName(n); len(s) == 3 {
			return getOperatorPath(s[1], s[2])
		}
	case ast.OBJECT_OPERATOR:
		if s := getQualifiedName(n); len(s) == 2 {
			return getOperatorPath(s[0], s[1])
		}
	case ast.OBJECT_OPFAMILY:
		if s := getQualifiedName(n); len(s) == 2 {
			return getSchemaPath(s[0])
		}
	case ast.OBJECT_PARAMETER_ACL:
		return variablesPath
	case ast.OBJECT_POLICY:
		if s := getQualifiedName(n); len(s) == 3 {
			return getPolicyPath(s[0], s[1])
		}
	case ast.OBJECT_PROCEDURE:
		if s := getQualifiedName(n); len(s) == 2 {
			return getProcedurePath(s[0], s[1])
		}
	case ast.OBJECT_PUBLICATION:
		return publicationsPath
	case ast.OBJECT_PUBLICATION_NAMESPACE:
		return publicationsPath
	case ast.OBJECT_PUBLICATION_REL:
		return publicationsPath
	case ast.OBJECT_ROLE:
		return rolesPath
	case ast.OBJECT_ROUTINE:
		if s := getQualifiedName(n); len(s) == 2 {
			return getFunctionPath(s[0], s[1])
		}
	case ast.OBJECT_RULE:
		if s := getQualifiedName(n); len(s) == 3 {
			return getPolicyPath(s[0], s[1])
		}
	case ast.OBJECT_SCHEMA:
		if s := getQualifiedName(n); len(s) == 1 {
			return getSchemaPath(s[0])
		}
	case ast.OBJECT_SEQUENCE:
		if s := getQualifiedName(n); len(s) == 2 {
			return getSequenceOrTablePath(s[0], s[1], seen)
		}
	case ast.OBJECT_SUBSCRIPTION:
		return subscriptionsPath
	// case ast.OBJECT_STATISTIC_EXT:
	case ast.OBJECT_TABCONSTRAINT:
		if s := getQualifiedName(n); len(s) == 3 {
			return getPolicyPath(s[0], s[1])
		}
	case ast.OBJECT_TABLE:
		if s := getQualifiedName(n); len(s) == 2 {
			// View and table grants can share the same keyword
			keys := []string{
				fmt.Sprintf("%s.%s.%s", obj, s[0], s[1]),
				fmt.Sprintf("%s.%s.%s", ast.OBJECT_VIEW, s[0], s[1]),
				fmt.Sprintf("%s.%s.%s", ast.OBJECT_MATVIEW, s[0], s[1]),
				fmt.Sprintf("%s.%s.%s", ast.OBJECT_FOREIGN_TABLE, s[0], s[1]),
			}
			for _, k := range keys {
				if fp, found := seen[k]; found {
					return fp
				}
			}
			return getTablePath(s[0], s[1])
		}
	case ast.OBJECT_TABLESPACE:
		return tablespacesPath
	case ast.OBJECT_TRANSFORM:
		if s := getQualifiedName(n); len(s) == 1 {
			if fp, found := seen[fmt.Sprintf("%s.%s", obj, s[0])]; found {
				return fp
			}
		}
	case ast.OBJECT_TRIGGER:
		if s := getQualifiedName(n); len(s) == 3 {
			return getFunctionPath(s[0], s[1])
		}
	case ast.OBJECT_TSCONFIGURATION:
		if s := getQualifiedName(n); len(s) == 2 {
			return getSchemaPath(s[0])
		}
	case ast.OBJECT_TSDICTIONARY:
		if s := getQualifiedName(n); len(s) == 2 {
			return getSchemaPath(s[0])
		}
	case ast.OBJECT_TSPARSER:
		if s := getQualifiedName(n); len(s) == 2 {
			return getSchemaPath(s[0])
		}
	case ast.OBJECT_TSTEMPLATE:
		if s := getQualifiedName(n); len(s) == 2 {
			return getSchemaPath(s[0])
		}
	case ast.OBJECT_TYPE:
		if s := getQualifiedName(n); len(s) == 2 {
			return getTypesPath(s[0])
		}
	case ast.OBJECT_USER_MAPPING:
		return foreignDWPath
	case ast.OBJECT_VIEW:
		if s := getQualifiedName(n); len(s) == 2 {
			return getViewPath(s[0], s[1])
		}
	}
	fmt.Fprintf(utils.GetDebugLogger(), "\tObject %s: %T\n", obj, n)
	return ""
}

func getQualifiedName(n ast.Node) []string {
	switch v := n.(type) {
	case *ast.NodeList:
		return toQualifiedName(v)
	case *ast.TypeName:
		return toQualifiedName(v.Names)
	case *ast.ObjectWithArgs:
		return toQualifiedName(v.Objname)
	case *ast.RangeVar:
		if len(v.SchemaName) > 0 {
			return []string{v.SchemaName, v.RelName}
		}
	case *ast.String:
		return []string{v.SVal}
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

func appendLine(name, data string, fsys afero.Fs) error {
	if err := utils.MkdirIfNotExistFS(fsys, filepath.Dir(name)); err != nil {
		return err
	}
	f, err := fsys.OpenFile(name, os.O_WRONLY|os.O_CREATE|os.O_APPEND, 0644)
	if err != nil {
		return errors.Errorf("failed to open file: %w", err)
	}
	defer f.Close()
	if _, err := fmt.Fprintln(f, data); err != nil {
		return errors.Errorf("failed to write file: %w", err)
	}
	return nil
}

// Non-greedy match of any character in [], including new lines
var pattern = regexp.MustCompile(`(?s)\nschema_paths = \[(.*?)\]\n`)

func appendConfig(fsys afero.Fs) error {
	lines := []string{"\nschema_paths = ["}
	for _, fp := range utils.Config.Db.Migrations.SchemaPaths {
		relPath, err := filepath.Rel(utils.SupabaseDirPath, fp)
		if err != nil {
			return errors.Errorf("failed to resolve path: %w", err)
		}
		lines = append(lines, fmt.Sprintf(`  "%s",`, relPath))
	}
	lines = append(lines, "]\n")
	schemaPaths := strings.Join(lines, "\n")
	// Attempt in-line config replacement
	data, err := afero.ReadFile(fsys, utils.ConfigPath)
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return errors.Errorf("failed to read config: %w", err)
	}
	if newConfig := pattern.ReplaceAllLiteral(data, []byte(schemaPaths)); bytes.Contains(newConfig, []byte(schemaPaths)) {
		return utils.WriteFile(utils.ConfigPath, newConfig, fsys)
	}
	// Fallback to append
	f, err := fsys.OpenFile(utils.ConfigPath, os.O_WRONLY|os.O_CREATE|os.O_APPEND, 0644)
	if err != nil {
		return errors.Errorf("failed to open config: %w", err)
	}
	defer f.Close()
	if _, err := f.WriteString("\n[db.migrations]"); err != nil {
		return errors.Errorf("failed to write header: %w", err)
	}
	if _, err := f.WriteString(schemaPaths); err != nil {
		return errors.Errorf("failed to write config: %w", err)
	}
	return nil
}
