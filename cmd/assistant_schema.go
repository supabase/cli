package cmd

import (
	"database/sql"
	"fmt"
	"os"

	_ "github.com/lib/pq" // Postgres driver
)

// analyzeSchema handles the main schema analysis
func analyzeSchema(table string) (*ToolResponse, error) {
	if table == "all" {
		tables, err := listTables()
		if err != nil {
			return &ToolResponse{
				Success: false,
				Result:  fmt.Sprintf("Error listing tables: %v", err),
			}, nil
		}
		return &ToolResponse{
			Success: true,
			Result:  fmt.Sprintf("Found tables:\n%s", tables),
		}, nil
	}

	schema, err := getTableSchema(table)
	if err != nil {
		return &ToolResponse{
			Success: false,
			Result:  fmt.Sprintf("Error getting schema for %s: %v", table, err),
		}, nil
	}

	rls, err := getTableRLS(table)
	if err != nil {
		return &ToolResponse{
			Success: false,
			Result:  fmt.Sprintf("Error getting RLS for %s: %v", table, err),
		}, nil
	}

	return &ToolResponse{
		Success: true,
		Result: fmt.Sprintf("Table: %s\n\nSchema:\n%s\n\nRow Level Security:\n%s",
			table, schema, rls),
	}, nil
}

func listTables() (string, error) {
	db, err := getDB()
	if err != nil {
		return "", fmt.Errorf("error connecting to database: %w", err)
	}
	defer db.Close()

	rows, err := db.Query(`
		SELECT table_name 
		FROM information_schema.tables 
		WHERE table_schema = 'public'
		ORDER BY table_name;
	`)
	if err != nil {
		return "", fmt.Errorf("error querying tables: %w", err)
	}
	defer rows.Close()

	var tables string
	for rows.Next() {
		var tableName string
		if err := rows.Scan(&tableName); err != nil {
			return "", fmt.Errorf("error scanning row: %w", err)
		}
		tables += fmt.Sprintf("Found table: %s\n", tableName)
	}

	if tables == "" {
		return "No tables found.", nil
	}

	return tables, nil
}

func getTableSchema(table string) (string, error) {
	db, err := getDB()
	if err != nil {
		return "", fmt.Errorf("error connecting to database: %w", err)
	}
	defer db.Close()

	rows, err := db.Query(`
		SELECT 
			column_name,
			data_type,
			is_nullable,
			COALESCE(column_default, 'NULL') as column_default,
			CASE 
				WHEN is_identity = 'YES' THEN 'IDENTITY'
				WHEN is_generated = 'ALWAYS' THEN 'GENERATED'
				ELSE ''
			END as special
		FROM information_schema.columns
		WHERE table_schema = 'public'
			AND table_name = $1
		ORDER BY ordinal_position;
	`, table)
	if err != nil {
		return "", fmt.Errorf("error querying schema: %w", err)
	}
	defer rows.Close()

	var schema string
	for rows.Next() {
		var colName, dataType, nullable, defaultVal, special string
		if err := rows.Scan(&colName, &dataType, &nullable, &defaultVal, &special); err != nil {
			return "", fmt.Errorf("error scanning row: %w", err)
		}
		schema += fmt.Sprintf("Column: %s\nType: %s\nNullable: %s\nDefault: %s\nSpecial: %s\n\n",
			colName, dataType, nullable, defaultVal, special)
	}

	if schema == "" {
		return "No columns found.", nil
	}

	return schema, nil
}

// getDB returns a database connection
func getDB() (*sql.DB, error) {
	connStr := fmt.Sprintf("host=%s port=%s user=%s password=%s dbname=%s sslmode=disable",
		os.Getenv(EnvPGHost),
		os.Getenv(EnvPGPort),
		os.Getenv(EnvPGUser),
		os.Getenv(EnvPGPassword),
		os.Getenv(EnvPGDatabase))

	return sql.Open("postgres", connStr)
}

// Convert getTableRLS to use database/sql
func getTableRLS(table string) (string, error) {
	db, err := getDB()
	if err != nil {
		return "", fmt.Errorf("error connecting to database: %w", err)
	}
	defer db.Close()

	rows, err := db.Query(`
		SELECT 
			pol.polname as policy_name,
			CASE WHEN pol.polpermissive THEN 'PERMISSIVE' ELSE 'RESTRICTIVE' END as policy_type,
			CASE 
				WHEN pol.polroles = '{0}' THEN 'PUBLIC'
				ELSE array_to_string(ARRAY(
					SELECT rolname 
					FROM pg_roles 
					WHERE oid = ANY(pol.polroles)
				), ',')
			END as roles,
			pol.polcmd as operation,
			pg_get_expr(pol.polqual, pol.polrelid) as using_expression,
			pg_get_expr(pol.polwithcheck, pol.polrelid) as with_check_expression
		FROM pg_policy pol
		JOIN pg_class cls ON pol.polrelid = cls.oid
		WHERE cls.relname = $1;
	`, table)
	if err != nil {
		return "", fmt.Errorf("error querying RLS: %w", err)
	}
	defer rows.Close()

	var policies string
	for rows.Next() {
		var name, ptype, roles, op, using, check string
		if err := rows.Scan(&name, &ptype, &roles, &op, &using, &check); err != nil {
			return "", fmt.Errorf("error scanning row: %w", err)
		}
		policies += fmt.Sprintf("Policy: %s\nType: %s\nRoles: %s\nOperation: %s\nUsing: %s\nWith Check: %s\n\n",
			name, ptype, roles, op, using, check)
	}

	return policies, nil
}

func analyzeFunctions(name string, schema string) (*ToolResponse, error) {
	if name == "all" {
		funcs, err := listFunctions(schema)
		if err != nil {
			return &ToolResponse{
				Success: false,
				Result:  fmt.Sprintf("Error listing functions: %v", err),
			}, nil
		}
		return &ToolResponse{
			Success: true,
			Result:  fmt.Sprintf("Found functions in schema %s:\n%s", schema, funcs),
		}, nil
	}

	details, err := getFunctionDetails(name, schema)
	if err != nil {
		return &ToolResponse{
			Success: false,
			Result:  fmt.Sprintf("Error getting function details for %s: %v", name, err),
		}, nil
	}

	security, err := getFunctionSecurity(name, schema)
	if err != nil {
		return &ToolResponse{
			Success: false,
			Result:  fmt.Sprintf("Error getting function security for %s: %v", name, err),
		}, nil
	}

	return &ToolResponse{
		Success: true,
		Result: fmt.Sprintf("Function: %s\n\nDefinition:\n%s\n\nSecurity:\n%s",
			name, details, security),
	}, nil
}

func listFunctions(schema string) (string, error) {
	db, err := getDB()
	if err != nil {
		return "", fmt.Errorf("error connecting to database: %w", err)
	}
	defer db.Close()

	rows, err := db.Query(`
		SELECT 
			p.proname as name,
			pg_get_function_arguments(p.oid) as arguments,
			t.typname as return_type
		FROM pg_proc p
		JOIN pg_type t ON p.prorettype = t.oid
		JOIN pg_namespace n ON p.pronamespace = n.oid
		WHERE n.nspname = $1
		ORDER BY p.proname;
	`, schema)
	if err != nil {
		return "", fmt.Errorf("error querying functions: %w", err)
	}
	defer rows.Close()

	var funcs string
	for rows.Next() {
		var name, args, retType string
		if err := rows.Scan(&name, &args, &retType); err != nil {
			return "", fmt.Errorf("error scanning row: %w", err)
		}
		funcs += fmt.Sprintf("%s(%s) RETURNS %s\n", name, args, retType)
	}

	return funcs, nil
}

func getFunctionDetails(name, schema string) (string, error) {
	db, err := getDB()
	if err != nil {
		return "", fmt.Errorf("error connecting to database: %w", err)
	}
	defer db.Close()

	rows, err := db.Query(`
		SELECT 
			p.proname as name,
			pg_get_functiondef(p.oid) as definition,
			pg_get_function_arguments(p.oid) as arguments,
			t.typname as return_type,
			p.prosrc as source
		FROM pg_proc p
		JOIN pg_type t ON p.prorettype = t.oid
		JOIN pg_namespace n ON p.pronamespace = n.oid
		WHERE n.nspname = $1
		AND p.proname = $2;
	`, schema, name)
	if err != nil {
		return "", fmt.Errorf("error querying function details: %w", err)
	}
	defer rows.Close()

	var details string
	for rows.Next() {
		var name, def, args, retType, src string
		if err := rows.Scan(&name, &def, &args, &retType, &src); err != nil {
			return "", fmt.Errorf("error scanning row: %w", err)
		}
		details += fmt.Sprintf("Name: %s\nArguments: %s\nReturns: %s\nDefinition:\n%s\nSource:\n%s\n",
			name, args, retType, def, src)
	}

	return details, nil
}

func getFunctionSecurity(name, schema string) (string, error) {
	db, err := getDB()
	if err != nil {
		return "", fmt.Errorf("error connecting to database: %w", err)
	}
	defer db.Close()

	rows, err := db.Query(`
		SELECT 
			p.proname as name,
			CASE 
				WHEN p.prosecdef THEN 'SECURITY DEFINER'
				ELSE 'SECURITY INVOKER'
			END as security,
			CASE WHEN p.proleakproof THEN 'LEAKPROOF' ELSE 'NOT LEAKPROOF' END as leakproof,
			array_to_string(ARRAY(
				SELECT rolname 
				FROM pg_roles 
				WHERE oid = ANY(p.proacl::regrole[])
			), ',') as grantees
		FROM pg_proc p
		JOIN pg_namespace n ON p.pronamespace = n.oid
		WHERE n.nspname = $1
		AND p.proname = $2;
	`, schema, name)
	if err != nil {
		return "", fmt.Errorf("error querying function security: %w", err)
	}
	defer rows.Close()

	var security string
	for rows.Next() {
		var name, sec, leak, grantees string
		if err := rows.Scan(&name, &sec, &leak, &grantees); err != nil {
			return "", fmt.Errorf("error scanning row: %w", err)
		}
		security += fmt.Sprintf("Security: %s\nLeakproof: %s\nGrantees: %s\n",
			sec, leak, grantees)
	}

	return security, nil
}
