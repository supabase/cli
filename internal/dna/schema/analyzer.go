package schema

import (
	"context"
	"database/sql"
	"fmt"
	"strings"
)

// SchemaInfo represents the database schema information
type SchemaInfo struct {
	Tables      []TableInfo
	Extensions  []string
	Constraints []ConstraintInfo
	Indexes     []IndexInfo
}

// TableInfo represents a database table
type TableInfo struct {
	Name        string
	Columns     []ColumnInfo
	Constraints []ConstraintInfo
	Indexes     []IndexInfo
	RowCount    int64
}

// ColumnInfo represents a table column
type ColumnInfo struct {
	Name         string
	Type         string
	IsNullable   bool
	DefaultValue sql.NullString
	IsPrimaryKey bool
	IsForeignKey bool
	References   *ForeignKeyInfo
}

// ConstraintInfo represents a table constraint
type ConstraintInfo struct {
	Name       string
	Type       string
	Table      string
	Columns    []string
	Definition string
}

// IndexInfo represents a table index
type IndexInfo struct {
	Name       string
	Table      string
	Columns    []string
	IsUnique   bool
	Definition string
}

// ForeignKeyInfo represents a foreign key relationship
type ForeignKeyInfo struct {
	Table     string
	Column    string
	RefTable  string
	RefColumn string
}

// Analyzer provides methods to analyze database schema
type Analyzer struct {
	db *sql.DB
}

// NewAnalyzer creates a new schema analyzer
func NewAnalyzer(db *sql.DB) *Analyzer {
	return &Analyzer{db: db}
}

// GetSchemaInfo retrieves complete schema information
func (a *Analyzer) GetSchemaInfo(ctx context.Context) (*SchemaInfo, error) {
	info := &SchemaInfo{}

	// Get enabled extensions
	extensions, err := a.getExtensions(ctx)
	if err != nil {
		return nil, fmt.Errorf("failed to get extensions: %w", err)
	}
	info.Extensions = extensions

	// Get tables
	tables, err := a.getTables(ctx)
	if err != nil {
		return nil, fmt.Errorf("failed to get tables: %w", err)
	}
	info.Tables = tables

	// Get constraints
	constraints, err := a.getConstraints(ctx)
	if err != nil {
		return nil, fmt.Errorf("failed to get constraints: %w", err)
	}
	info.Constraints = constraints

	// Get indexes
	indexes, err := a.getIndexes(ctx)
	if err != nil {
		return nil, fmt.Errorf("failed to get indexes: %w", err)
	}
	info.Indexes = indexes

	return info, nil
}

func (a *Analyzer) getExtensions(ctx context.Context) ([]string, error) {
	query := `
		SELECT extname 
		FROM pg_extension 
		WHERE extname != 'plpgsql'
		ORDER BY extname;
	`

	rows, err := a.db.QueryContext(ctx, query)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var extensions []string
	for rows.Next() {
		var ext string
		if err := rows.Scan(&ext); err != nil {
			return nil, err
		}
		extensions = append(extensions, ext)
	}

	return extensions, rows.Err()
}

func (a *Analyzer) getTables(ctx context.Context) ([]TableInfo, error) {
	query := `
		SELECT 
			t.table_name,
			array_agg(DISTINCT c.column_name) as columns,
			array_agg(DISTINCT c.data_type) as types,
			array_agg(DISTINCT c.is_nullable) as nullables,
			array_agg(DISTINCT c.column_default) as defaults
		FROM information_schema.tables t
		JOIN information_schema.columns c ON t.table_name = c.table_name
		WHERE t.table_schema = 'public'
		AND t.table_type = 'BASE TABLE'
		GROUP BY t.table_name
		ORDER BY t.table_name;
	`

	rows, err := a.db.QueryContext(ctx, query)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var tables []TableInfo
	for rows.Next() {
		var table TableInfo
		var columnNames, columnTypes, columnNullables, columnDefaults []string

		if err := rows.Scan(
			&table.Name,
			&columnNames,
			&columnTypes,
			&columnNullables,
			&columnDefaults,
		); err != nil {
			return nil, err
		}

		// Build column info
		for i := range columnNames {
			col := ColumnInfo{
				Name:       columnNames[i],
				Type:       columnTypes[i],
				IsNullable: columnNullables[i] == "YES",
			}
			if i < len(columnDefaults) && columnDefaults[i] != "" {
				col.DefaultValue = sql.NullString{
					String: columnDefaults[i],
					Valid:  true,
				}
			}
			table.Columns = append(table.Columns, col)
		}

		// Get row count
		var count int64
		countQuery := fmt.Sprintf("SELECT COUNT(*) FROM %s", table.Name)
		if err := a.db.QueryRowContext(ctx, countQuery).Scan(&count); err != nil {
			// Log error but continue
			fmt.Printf("Warning: Failed to get row count for %s: %v\n", table.Name, err)
		}
		table.RowCount = count

		tables = append(tables, table)
	}

	return tables, rows.Err()
}

func (a *Analyzer) getConstraints(ctx context.Context) ([]ConstraintInfo, error) {
	query := `
		SELECT 
			c.conname as name,
			c.contype as type,
			t.relname as table_name,
			array_agg(a.attname) as columns,
			pg_get_constraintdef(c.oid) as definition
		FROM pg_constraint c
		JOIN pg_class t ON c.conrelid = t.oid
		JOIN pg_namespace n ON t.relnamespace = n.oid
		JOIN pg_attribute a ON a.attrelid = t.oid 
		WHERE n.nspname = 'public'
		AND a.attnum = ANY(c.conkey)
		GROUP BY c.conname, c.contype, t.relname, c.oid
		ORDER BY t.relname, c.conname;
	`

	rows, err := a.db.QueryContext(ctx, query)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var constraints []ConstraintInfo
	for rows.Next() {
		var c ConstraintInfo
		if err := rows.Scan(&c.Name, &c.Type, &c.Table, &c.Columns, &c.Definition); err != nil {
			return nil, err
		}
		constraints = append(constraints, c)
	}

	return constraints, rows.Err()
}

func (a *Analyzer) getIndexes(ctx context.Context) ([]IndexInfo, error) {
	query := `
		SELECT 
			i.relname as name,
			t.relname as table_name,
			array_agg(a.attname) as columns,
			ix.indisunique as is_unique,
			pg_get_indexdef(i.oid) as definition
		FROM pg_index ix
		JOIN pg_class i ON i.oid = ix.indexrelid
		JOIN pg_class t ON t.oid = ix.indrelid
		JOIN pg_namespace n ON n.oid = t.relnamespace
		JOIN pg_attribute a ON a.attrelid = t.oid
		WHERE n.nspname = 'public'
		AND a.attnum = ANY(ix.indkey)
		AND t.relkind = 'r'
		GROUP BY i.relname, t.relname, ix.indisunique, i.oid
		ORDER BY t.relname, i.relname;
	`

	rows, err := a.db.QueryContext(ctx, query)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var indexes []IndexInfo
	for rows.Next() {
		var idx IndexInfo
		if err := rows.Scan(&idx.Name, &idx.Table, &idx.Columns, &idx.IsUnique, &idx.Definition); err != nil {
			return nil, err
		}
		indexes = append(indexes, idx)
	}

	return indexes, rows.Err()
}

// AnalyzeNormalization checks the schema for normalization issues
func (a *Analyzer) AnalyzeNormalization(ctx context.Context) ([]NormalizationIssue, error) {
	var issues []NormalizationIssue

	// Get schema info
	schema, err := a.GetSchemaInfo(ctx)
	if err != nil {
		return nil, err
	}

	// Check each table
	for _, table := range schema.Tables {
		// Check for 1NF violations (non-atomic values)
		for _, col := range table.Columns {
			if strings.Contains(col.Type, "ARRAY") || strings.Contains(col.Type, "JSON") {
				issues = append(issues, NormalizationIssue{
					Level:      "1NF",
					Table:      table.Name,
					Column:     col.Name,
					Issue:      "Non-atomic values",
					Suggestion: fmt.Sprintf("Consider normalizing %s into a separate table", col.Name),
				})
			}
		}

		// Check for potential 2NF violations (partial dependencies)
		pkColumns := a.getPrimaryKeyColumns(table)
		if len(pkColumns) > 1 {
			for _, col := range table.Columns {
				if !contains(pkColumns, col.Name) {
					issues = append(issues, NormalizationIssue{
						Level:      "2NF",
						Table:      table.Name,
						Column:     col.Name,
						Issue:      "Potential partial dependency",
						Suggestion: "Verify if this column depends on the full primary key",
					})
				}
			}
		}

		// Check for potential 3NF violations (transitive dependencies)
		for _, col1 := range table.Columns {
			for _, col2 := range table.Columns {
				if col1.Name != col2.Name && !col1.IsPrimaryKey && !col2.IsPrimaryKey {
					if a.mightHaveTransitiveDependency(ctx, table.Name, col1.Name, col2.Name) {
						issues = append(issues, NormalizationIssue{
							Level:      "3NF",
							Table:      table.Name,
							Column:     fmt.Sprintf("%s -> %s", col1.Name, col2.Name),
							Issue:      "Potential transitive dependency",
							Suggestion: "Consider moving these columns to a separate table",
						})
					}
				}
			}
		}
	}

	return issues, nil
}

// NormalizationIssue represents a potential normalization problem
type NormalizationIssue struct {
	Level      string // 1NF, 2NF, 3NF
	Table      string
	Column     string
	Issue      string
	Suggestion string
}

func (a *Analyzer) getPrimaryKeyColumns(table TableInfo) []string {
	var pkColumns []string
	for _, col := range table.Columns {
		if col.IsPrimaryKey {
			pkColumns = append(pkColumns, col.Name)
		}
	}
	return pkColumns
}

func (a *Analyzer) mightHaveTransitiveDependency(ctx context.Context, table, col1, col2 string) bool {
	// This is a simplified check - in reality, you'd need more sophisticated analysis
	query := fmt.Sprintf(`
		SELECT COUNT(DISTINCT %s) = COUNT(DISTINCT (%s, %s))
		FROM %s
		HAVING COUNT(*) > 0;
	`, col1, col1, col2, table)

	var hasTransitive bool
	err := a.db.QueryRowContext(ctx, query).Scan(&hasTransitive)
	if err != nil {
		return false
	}
	return hasTransitive
}

func contains(slice []string, str string) bool {
	for _, s := range slice {
		if s == str {
			return true
		}
	}
	return false
}
