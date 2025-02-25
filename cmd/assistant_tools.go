package cmd

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"os"
	"runtime"
	"strconv"
	"strings"

	_ "github.com/lib/pq"
	"github.com/sashabaranov/go-openai"
	"github.com/spf13/afero"
	"github.com/supabase/cli/internal/migration/new"
	"github.com/supabase/cli/internal/utils/flags"
)

var LineSep string

func init() {
	if runtime.GOOS == "windows" {
		LineSep = "\r\n"
	} else {
		LineSep = "\n"
	}
}

const (
	String = "string"
	Object = "object"
	Bool   = "boolean"
)

const defaultMigrationsPath = "supabase/migrations"

type Definition struct {
	Type        string                `json:"type"`
	Description string                `json:"description,omitempty"`
	Properties  map[string]Definition `json:"properties,omitempty"`
	Required    []string              `json:"required,omitempty"`
	Enum        []string              `json:"enum,omitempty"`
}

type ToolResponse struct {
	Result  string `json:"result"`
	Success bool   `json:"success"`
}

// can this be put inside the other tools list?
var migrationTools = []openai.FunctionDefinition{
	{
		Name:        "create_migration",
		Description: "Create a new SQL migration file with a timestamped name in the supabase/migrations directory",
		Parameters: Definition{
			Type: String,
			Properties: map[string]Definition{
				"name": {
					Type:        String,
					Description: "Descriptive name for the migration (e.g., 'add_user_table', 'update_post_constraints')",
				},
				"sql": {
					Type:        String,
					Description: "SQL statements to be executed in the migration (should include BEGIN and COMMIT)",
				},
			},
			Required: []string{"name", "sql"},
		},
	},
	{
		Name:        "apply_migration",
		Description: "Apply all pending migrations to the database in sequential order",
		Parameters: Definition{
			Type: String,
			Properties: map[string]Definition{
				"target": {
					Type:        String,
					Enum:        []string{"local", "linked"},
					Description: "Target database: 'local' for development or 'linked' for remote Supabase project",
				},
			},
		},
	},
	{
		Name:        "edit_migration",
		Description: "Modify an existing migration file in the supabase/migrations directory",
		Parameters: Definition{
			Type: String,
			Properties: map[string]Definition{
				"filename": {
					Type:        String,
					Description: "Full filename of the migration to edit (e.g., '20250220171330_add_likes.sql')",
				},
				"sql": {
					Type:        String,
					Description: "New SQL content to replace the existing migration (should include BEGIN and COMMIT)",
				},
			},
			Required: []string{"filename", "sql"},
		},
	},
}

// Combine all tools
var tools = []openai.FunctionDefinition{
	// Existing tools
	{
		Name:        "search_supabase_docs",
		Description: "Search Supabase documentation",
		Parameters: Definition{
			Type: String,
			Properties: map[string]Definition{
				"query": {
					Type:        String,
					Description: "Query to search for",
				},
				"topic": {
					Type:        String,
					Description: "Topic to search within",
				},
			},
			Required: []string{"query", "topic"},
		},
	},
	{
		Name:        "analyze_schema",
		Description: "Analyze database schema",
		Parameters: Definition{
			Type: String,
			Properties: map[string]Definition{
				"table": {
					Type:        String,
					Description: "Name of the table to analyze",
				},
			},
			Required: []string{"table"},
		},
	},
	{
		Name:        "analyze_functions",
		Description: "Analyze stored procedures",
		Parameters: Definition{
			Type: String,
			Properties: map[string]Definition{
				"name": {
					Type:        String,
					Description: "Name of the function",
				},
				"schema": {
					Type:        String,
					Description: "Schema of the function",
				},
			},
			Required: []string{"name", "schema"},
		},
	},
	{
		Name:        "get_cli_help",
		Description: "Get CLI help information",
		Parameters: Definition{
			Type: String,
			Properties: map[string]Definition{
				"command": {
					Type:        String,
					Description: "Command to get help for",
				},
			},
			Required: []string{"command"},
		},
	},
	// Add migration tools
	{
		Name:        "create_migration",
		Description: "Create a new SQL migration file with a timestamped name in the supabase/migrations directory",
		Parameters: Definition{
			Type: String,
			Properties: map[string]Definition{
				"name": {
					Type:        String,
					Description: "Descriptive name for the migration (e.g., 'add_user_table', 'update_post_constraints')",
				},
				"sql": {
					Type:        String,
					Description: "SQL statements to be executed in the migration (should include BEGIN and COMMIT)",
				},
			},
			Required: []string{"name", "sql"},
		},
	},
	{
		Name:        "apply_migration",
		Description: "Apply all pending migrations to the database in sequential order",
		Parameters: Definition{
			Type: String,
			Properties: map[string]Definition{
				"target": {
					Type:        String,
					Enum:        []string{"local", "linked"},
					Description: "Target database: 'local' for development or 'linked' for remote Supabase project",
				},
			},
		},
	},
	{
		Name:        "edit_migration",
		Description: "Modify an existing migration file in the supabase/migrations directory",
		Parameters: Definition{
			Type: String,
			Properties: map[string]Definition{
				"filename": {
					Type:        String,
					Description: "Full filename of the migration to edit (e.g., '20250220171330_add_likes.sql')",
				},
				"sql": {
					Type:        String,
					Description: "New SQL content to replace the existing migration (should include BEGIN and COMMIT)",
				},
			},
			Required: []string{"filename", "sql"},
		},
	},
	{
		Name:        "write_migration",
		Description: "Write SQL content to a migration file",
		Parameters: Definition{
			Type: String,
			Properties: map[string]Definition{
				"version": {
					Type:        String,
					Description: "IMPORTANT: Use the EXACT filename from create_migration, including both timestamp and name (e.g., if create_migration returns '20250221204247_enable_rls_and_restrict_access.sql', use that complete filename)",
				},
				"sql": {
					Type:        String,
					Description: "SQL content to write to the migration file (should include BEGIN and COMMIT)",
				},
			},
			Required: []string{"version", "sql"},
		},
	},
	{
		Name:        "list_migrations",
		Description: "List all migration files in the supabase/migrations directory",
		Parameters: Definition{
			Type:       String,
			Properties: map[string]Definition{},
		},
	},
	{
		Name:        "read_migration",
		Description: "Read the contents of a specific migration file",
		Parameters: Definition{
			Type: String,
			Properties: map[string]Definition{
				"version": {
					Type:        String,
					Description: "Version/timestamp of the migration file (e.g., '20250220171330')",
				},
			},
			Required: []string{"version"},
		},
	},
}

func handleToolCall(call *openai.FunctionCall) (*ToolResponse, error) {
	switch call.Name {
	case "search_supabase_docs":
		var params struct {
			Query string `json:"query"`
			Topic string `json:"topic"`
		}
		if err := json.Unmarshal([]byte(call.Arguments), &params); err != nil {
			return nil, err
		}
		return searchDocs(params.Query, params.Topic)

	case "analyze_schema":
		var params struct {
			Table string `json:"table"`
		}
		if err := json.Unmarshal([]byte(call.Arguments), &params); err != nil {
			return nil, err
		}
		return analyzeSchema(params.Table)

	case "analyze_functions":
		var params struct {
			Name   string `json:"name"`
			Schema string `json:"schema"`
		}
		if err := json.Unmarshal([]byte(call.Arguments), &params); err != nil {
			return nil, err
		}
		return analyzeFunctions(params.Name, params.Schema)

	case "create_migration":
		var params struct {
			Name string `json:"name"`
			SQL  string `json:"sql"`
		}
		if err := json.Unmarshal([]byte(call.Arguments), &params); err != nil {
			return nil, err
		}

		// Create an empty reader instead of using os.Stdin
		emptyReader := strings.NewReader(params.SQL)
		if err := new.Run(params.Name, emptyReader, afero.NewOsFs()); err != nil {
			return nil, err
		}

		// List migrations to find the one we just created
		fs := afero.NewOsFs()
		migrationsDir, err := findMigrationsDir(fs)
		if err != nil {
			return nil, err
		}
		files, err := afero.ReadDir(fs, migrationsDir)
		if err != nil {
			return nil, fmt.Errorf("failed to read migrations directory: %w", err)
		}

		// Find the most recent migration file that matches our name
		var newMigrationFile string
		var latestTime int64
		for _, f := range files {
			if !f.IsDir() && strings.HasSuffix(f.Name(), "_"+params.Name+".sql") {
				// FileInfo already has ModTime()
				if f.ModTime().Unix() > latestTime {
					latestTime = f.ModTime().Unix()
					newMigrationFile = f.Name()
				}
			}
		}

		if newMigrationFile == "" {
			return nil, fmt.Errorf("failed to find newly created migration file for: %s", params.Name)
		}

		return &ToolResponse{
			Result: fmt.Sprintf("Created new migration:%s%s%s%s%s",
				LineSep,
				newMigrationFile,
				LineSep,
				newMigrationFile,
				LineSep,
				newMigrationFile),
			Success: true,
		}, nil

	case "write_migration":
		var params struct {
			Version string `json:"version"`
			SQL     string `json:"sql"`
		}
		if err := json.Unmarshal([]byte(call.Arguments), &params); err != nil {
			return nil, err
		}

		fs := afero.NewOsFs()
		migrationsDir, err := findMigrationsDir(fs)
		if err != nil {
			return nil, err
		}

		// List available migrations first
		files, err := afero.ReadDir(fs, migrationsDir)
		if err != nil {
			return nil, fmt.Errorf("failed to read migrations directory: %w", err)
		}

		var migrations []string
		for _, f := range files {
			if !f.IsDir() && strings.HasSuffix(f.Name(), ".sql") {
				migrations = append(migrations, f.Name())
			}
		}

		// Find best matching file
		matchingFile, err := findMigrationFile(fs, params.Version)
		if err != nil {
			return nil, fmt.Errorf("available migrations:\n%s\nerror: %w",
				strings.Join(migrations, "\n"), err)
		}

		migrationPath := fmt.Sprintf("%s/%s", migrationsDir, matchingFile)
		if err := afero.WriteFile(fs, migrationPath, []byte(params.SQL), 0644); err != nil {
			return nil, fmt.Errorf("failed to write migration file: %w", err)
		}

		return &ToolResponse{
			Result: fmt.Sprintf("Successfully wrote SQL to migration file: %s%sContent:%s%s",
				migrationPath,
				LineSep,
				LineSep,
				params.SQL),
			Success: true,
		}, nil

	case "apply_migrations":
		var params struct {
			IncludeAll bool `json:"include_all"`
		}
		if err := json.Unmarshal([]byte(call.Arguments), &params); err != nil {
			return nil, err
		}

		fs := afero.NewOsFs()
		migrationsDir, err := findMigrationsDir(fs)
		if err != nil {
			return nil, err
		}

		// List available migrations first
		files, err := afero.ReadDir(fs, migrationsDir)
		if err != nil {
			return nil, fmt.Errorf("failed to read migrations directory: %w", err)
		}

		var migrations []string
		for _, f := range files {
			if !f.IsDir() && strings.HasSuffix(f.Name(), ".sql") {
				migrations = append(migrations, f.Name())
			}
		}

		if len(migrations) == 0 {
			return nil, fmt.Errorf("no migrations found in %s", migrationsDir)
		}

		fmt.Printf("Found migrations to apply:\n%s\n", strings.Join(migrations, "\n"))

		// Create a copy of DbConfig with values from environment
		migrationConfig := flags.DbConfig
		migrationConfig.Database = os.Getenv("PGDATABASE")
		if migrationConfig.Database == "" {
			migrationConfig.Database = "postgres"
		}
		migrationConfig.Host = os.Getenv("PGHOST")
		if migrationConfig.Host == "" {
			migrationConfig.Host = "localhost"
		}
		migrationConfig.Port = uint16(parsePort(os.Getenv("PGPORT"), 54322))
		migrationConfig.User = os.Getenv("PGUSER")
		if migrationConfig.User == "" {
			migrationConfig.User = "postgres"
		}
		migrationConfig.Password = os.Getenv("PGPASSWORD")
		if migrationConfig.Password == "" {
			migrationConfig.Password = "postgres"
		}

		connStr := fmt.Sprintf("postgresql://%s:%s@%s:%d/%s?sslmode=disable",
			migrationConfig.User,
			migrationConfig.Password,
			migrationConfig.Host,
			migrationConfig.Port,
			migrationConfig.Database)

		fmt.Printf("Attempting to connect to: %s\n", strings.Replace(connStr, migrationConfig.Password, "****", 1))

		if err := applyMigrationsDirectly(migrations, connStr); err != nil {
			return nil, fmt.Errorf("error applying migrations: %w", err)
		}

		return &ToolResponse{
			Result:  fmt.Sprintf("Successfully applied %d migrations to local database", len(migrations)),
			Success: true,
		}, nil

	case "list_migrations":
		fs := afero.NewOsFs()
		migrationsDir, err := findMigrationsDir(fs)
		if err != nil {
			return nil, err
		}
		files, err := afero.ReadDir(fs, migrationsDir)
		if err != nil {
			return nil, fmt.Errorf("failed to read migrations directory: %w", err)
		}

		var migrations []string
		for _, f := range files {
			if !f.IsDir() && strings.HasSuffix(f.Name(), ".sql") {
				migrations = append(migrations, f.Name())
			}
		}

		return &ToolResponse{
			Result:  fmt.Sprintf("Available migrations:\n%s", strings.Join(migrations, "\n")),
			Success: true,
		}, nil

	case "read_migration":
		var params struct {
			Version string `json:"version"`
		}
		if err := json.Unmarshal([]byte(call.Arguments), &params); err != nil {
			return nil, err
		}

		fs := afero.NewOsFs()
		migrationsDir, err := findMigrationsDir(fs)
		if err != nil {
			return nil, err
		}
		matchingFile, err := findMigrationFile(fs, params.Version)
		if err != nil {
			return nil, err
		}

		migrationPath := fmt.Sprintf("%s/%s", migrationsDir, matchingFile)
		content, err := afero.ReadFile(fs, migrationPath)
		if err != nil {
			return nil, fmt.Errorf("failed to read migration file: %w", err)
		}

		return &ToolResponse{
			Result:  string(content),
			Success: true,
		}, nil

	case "get_cli_help":
		var params struct {
			Command string `json:"command"`
		}
		if err := json.Unmarshal([]byte(call.Arguments), &params); err != nil {
			return nil, err
		}

		// Create a buffer to capture the help output
		var buf strings.Builder

		// Get the command to show help for
		cmd := rootCmd
		args := []string{}

		if params.Command != "" {
			args = append(args, params.Command, "--help")
		} else {
			args = append(args, "--help")
		}

		// Save the original output and error output
		oldOut := cmd.OutOrStdout()
		oldErr := cmd.ErrOrStderr()

		// Redirect output to our buffer
		cmd.SetOut(&buf)
		cmd.SetErr(&buf)

		// Execute the command with --help
		cmd.SetArgs(args)
		cmd.Execute()

		// Restore the original output
		cmd.SetOut(oldOut)
		cmd.SetErr(oldErr)

		return &ToolResponse{
			Result:  buf.String(),
			Success: true,
		}, nil

	default:
		return nil, fmt.Errorf("unknown function: %s", call.Name)
	}
}

func parsePort(portStr string, defaultPort uint16) uint16 {
	if portStr == "" {
		return defaultPort
	}
	port, err := strconv.ParseUint(portStr, 10, 16)
	if err != nil {
		return defaultPort
	}
	return uint16(port)
}

func findMigrationFile(fs afero.Fs, timestamp string) (string, error) {
	files, err := afero.ReadDir(fs, "supabase/migrations")
	if err != nil {
		return "", fmt.Errorf("failed to read migrations directory: %w", err)
	}

	// Clean the timestamp - remove .sql suffix if present
	timestamp = strings.TrimSuffix(timestamp, ".sql")

	var bestMatch string
	var longestMatch int

	for _, f := range files {
		if !f.IsDir() && strings.HasSuffix(f.Name(), ".sql") {
			name := strings.TrimSuffix(f.Name(), ".sql")
			// Find the common prefix length
			prefixLen := 0
			for i := 0; i < len(timestamp) && i < len(name) && timestamp[i] == name[i]; i++ {
				prefixLen++
			}
			// Update if this is the longest match so far
			if prefixLen > longestMatch {
				longestMatch = prefixLen
				bestMatch = f.Name()
			}
		}
	}

	if bestMatch == "" {
		return "", fmt.Errorf("no migration file found matching: %s", timestamp)
	}

	return bestMatch, nil
}

func findMigrationsDir(fs afero.Fs) (string, error) {
	// Common migration directory patterns
	patterns := []string{
		"supabase/migrations",
		"migrations",
		"db/migrations",
		"database/migrations",
	}

	// Try exact matches first
	for _, path := range patterns {
		exists, _ := afero.DirExists(fs, path)
		if exists {
			return path, nil
		}
	}

	// If no exact match, look for longest matching prefix
	files, err := afero.ReadDir(fs, ".")
	if err != nil {
		return defaultMigrationsPath, nil // Fall back to default
	}

	var bestMatch string
	var longestMatch int
	for _, f := range files {
		if f.IsDir() {
			// Look for directories containing "migration"
			if strings.Contains(strings.ToLower(f.Name()), "migration") {
				if len(f.Name()) > longestMatch {
					longestMatch = len(f.Name())
					bestMatch = f.Name()
				}
			}
		}
	}

	if bestMatch != "" {
		return bestMatch, nil
	}

	return defaultMigrationsPath, nil
}

func applyMigrationsDirectly(files []string, connStr string) error {
	db, err := sql.Open("postgres", connStr)
	if err != nil {
		return fmt.Errorf("failed to connect to database: %w", err)
	}
	defer db.Close()

	// Create version tracking table if it doesn't exist
	_, err = db.Exec(`
		CREATE SCHEMA IF NOT EXISTS supabase_migrations;
		CREATE TABLE IF NOT EXISTS supabase_migrations.schema_migrations (
			version text PRIMARY KEY,
			applied_at timestamptz DEFAULT now()
		)
	`)
	if err != nil {
		return fmt.Errorf("failed to create migrations table: %w", err)
	}

	// Apply each migration in a transaction
	for _, file := range files {
		var exists bool
		err = db.QueryRow("SELECT EXISTS(SELECT 1 FROM supabase_migrations.schema_migrations WHERE version = $1)", file).Scan(&exists)
		if err != nil {
			return fmt.Errorf("failed to check migration status: %w", err)
		}
		if exists {
			fmt.Printf("Skipping %s (already applied)\n", file)
			continue
		}

		fmt.Printf("Applying %s...\n", file)
		content, err := afero.ReadFile(afero.NewOsFs(), "supabase/migrations/"+file)
		if err != nil {
			return fmt.Errorf("failed to read migration file: %w", err)
		}

		tx, err := db.Begin()
		if err != nil {
			return fmt.Errorf("failed to start transaction: %w", err)
		}

		if _, err := tx.Exec(string(content)); err != nil {
			tx.Rollback()
			return fmt.Errorf("failed to apply migration %s: %w", file, err)
		}

		if _, err := tx.Exec("INSERT INTO supabase_migrations.schema_migrations (version) VALUES ($1)", file); err != nil {
			tx.Rollback()
			return fmt.Errorf("failed to record migration %s: %w", file, err)
		}

		if err := tx.Commit(); err != nil {
			return fmt.Errorf("failed to commit migration %s: %w", file, err)
		}
		fmt.Printf("Successfully applied %s\n", file)
	}
	return nil
}
