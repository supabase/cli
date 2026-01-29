package dev

import (
	"fmt"

	"github.com/go-errors/errors"
	pg_query "github.com/pganalyze/pg_query_go/v6"
	"github.com/spf13/afero"
	"github.com/supabase/cli/internal/utils"
)

// ValidationError represents a SQL syntax error with location info
type ValidationError struct {
	File    string
	Line    int
	Column  int
	Message string
}

func (e *ValidationError) Error() string {
	return fmt.Sprintf("Syntax error in %s\n    Line %d, Column %d: %s\n    Waiting for valid SQL...",
		e.File, e.Line, e.Column, e.Message)
}

// ValidateSchemaFiles validates the SQL syntax of all schema files
// Returns nil if all files are valid, or the first error encountered
func ValidateSchemaFiles(files []string, fsys afero.Fs) error {
	for _, file := range files {
		if err := validateFile(file, fsys); err != nil {
			return err
		}
	}
	return nil
}

// validateFile validates a single SQL file using pg_query (Postgres's actual parser)
func validateFile(path string, fsys afero.Fs) error {
	content, err := afero.ReadFile(fsys, path)
	if err != nil {
		return errors.Errorf("failed to read %s: %w", path, err)
	}

	// Empty files are valid
	if len(content) == 0 {
		return nil
	}

	// Parse the SQL using pg_query (Postgres's actual parser)
	_, err = pg_query.Parse(string(content))
	if err != nil {
		return parseError(path, string(content), err)
	}

	fmt.Fprintf(utils.GetDebugLogger(), "Validated: %s\n", path)
	return nil
}

// parseError converts a pg_query error into a ValidationError with location info
func parseError(file, content string, err error) error {
	errMsg := err.Error()

	// Default to line 1, column 1 if we can't parse the position
	line := 1
	column := 1

	// Try to extract position from error message
	// pg_query errors look like: "syntax error at or near \"xyz\" at position 123"
	var pos int
	if n, _ := fmt.Sscanf(errMsg, "syntax error at or near %*s at position %d", &pos); n == 1 && pos > 0 {
		line, column = offsetToLineCol(content, pos)
	}

	return &ValidationError{
		File:    file,
		Line:    line,
		Column:  column,
		Message: errMsg,
	}
}

// offsetToLineCol converts a byte offset to line and column numbers (1-indexed)
func offsetToLineCol(content string, offset int) (line, col int) {
	line = 1
	col = 1
	for i := 0; i < len(content) && i < offset; i++ {
		if content[i] == '\n' {
			line++
			col = 1
		} else {
			col++
		}
	}
	return line, col
}
