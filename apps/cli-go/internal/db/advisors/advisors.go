package advisors

import (
	"context"
	_ "embed"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"strings"

	"github.com/go-errors/errors"
	"github.com/jackc/pgconn"
	"github.com/jackc/pgx/v4"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/pkg/api"
)

var (
	AllowedLevels = []string{
		"info",
		"warn",
		"error",
	}

	AllowedTypes = []string{
		"all",
		"security",
		"performance",
	}

	//go:embed templates/lints.sql
	lintsSQL string
)

type LintLevel int

func toEnum(level string) LintLevel {
	switch level {
	case "INFO", "info":
		return 0
	case "WARN", "warn":
		return 1
	case "ERROR", "error":
		return 2
	}
	return -1
}

type Lint struct {
	Name        string           `json:"name"`
	Title       string           `json:"title"`
	Level       string           `json:"level"`
	Facing      string           `json:"facing"`
	Categories  []string         `json:"categories"`
	Description string           `json:"description"`
	Detail      string           `json:"detail"`
	Remediation string           `json:"remediation"`
	Metadata    *json.RawMessage `json:"metadata,omitempty"`
	CacheKey    string           `json:"cache_key"`
}

func RunLocal(ctx context.Context, advisorType string, level string, failOn string, config pgconn.Config, options ...func(*pgx.ConnConfig)) error {
	conn, err := utils.ConnectByConfig(ctx, config, options...)
	if err != nil {
		return err
	}
	defer conn.Close(context.Background())

	lints, err := queryLints(ctx, conn)
	if err != nil {
		return err
	}

	filtered := filterLints(lints, advisorType, level)
	return outputAndCheck(filtered, failOn, os.Stdout)
}

func RunLinked(ctx context.Context, advisorType string, level string, failOn string, projectRef string) error {
	var lints []Lint

	if advisorType == "all" || advisorType == "security" {
		securityLints, err := fetchSecurityAdvisors(ctx, projectRef)
		if err != nil {
			return err
		}
		lints = append(lints, securityLints...)
	}

	if advisorType == "all" || advisorType == "performance" {
		perfLints, err := fetchPerformanceAdvisors(ctx, projectRef)
		if err != nil {
			return err
		}
		lints = append(lints, perfLints...)
	}

	filtered := filterLints(lints, "all", level)
	return outputAndCheck(filtered, failOn, os.Stdout)
}

func queryLints(ctx context.Context, conn *pgx.Conn) ([]Lint, error) {
	tx, err := conn.Begin(ctx)
	if err != nil {
		return nil, errors.Errorf("failed to begin transaction: %w", err)
	}
	defer func() {
		if err := tx.Rollback(context.Background()); err != nil {
			fmt.Fprintln(os.Stderr, err)
		}
	}()

	setupSQL, querySQL := splitLintsSQL()
	if _, err := tx.Exec(ctx, setupSQL); err != nil {
		return nil, errors.Errorf("failed to prepare lint session: %w", err)
	}

	rows, err := tx.Query(ctx, querySQL)
	if err != nil {
		return nil, errors.Errorf("failed to query lints: %w", err)
	}
	defer rows.Close()

	var lints []Lint
	for rows.Next() {
		var l Lint
		var metadata []byte
		if err := rows.Scan(
			&l.Name,
			&l.Title,
			&l.Level,
			&l.Facing,
			&l.Categories,
			&l.Description,
			&l.Detail,
			&l.Remediation,
			&metadata,
			&l.CacheKey,
		); err != nil {
			return nil, errors.Errorf("failed to scan lint row: %w", err)
		}
		if len(metadata) > 0 {
			raw := json.RawMessage(metadata)
			l.Metadata = &raw
		}
		lints = append(lints, l)
	}
	if err := rows.Err(); err != nil {
		return nil, errors.Errorf("failed to parse lint rows: %w", err)
	}
	return lints, nil
}

func splitLintsSQL() (string, string) {
	setupSQL, querySQL, found := strings.Cut(lintsSQL, ";\n\n")
	if !found {
		return "", lintsSQL
	}
	return setupSQL, querySQL
}

func fetchSecurityAdvisors(ctx context.Context, projectRef string) ([]Lint, error) {
	resp, err := utils.GetSupabase().V1GetSecurityAdvisorsWithResponse(ctx, projectRef, &api.V1GetSecurityAdvisorsParams{})
	if err != nil {
		return nil, errors.Errorf("failed to fetch security advisors: %w", err)
	}
	if resp.JSON200 == nil {
		return nil, errors.Errorf("unexpected security advisors status %d: %s", resp.StatusCode(), string(resp.Body))
	}
	return apiResponseToLints(resp.JSON200), nil
}

func fetchPerformanceAdvisors(ctx context.Context, projectRef string) ([]Lint, error) {
	resp, err := utils.GetSupabase().V1GetPerformanceAdvisorsWithResponse(ctx, projectRef)
	if err != nil {
		return nil, errors.Errorf("failed to fetch performance advisors: %w", err)
	}
	if resp.JSON200 == nil {
		return nil, errors.Errorf("unexpected performance advisors status %d: %s", resp.StatusCode(), string(resp.Body))
	}
	return apiResponseToLints(resp.JSON200), nil
}

func apiResponseToLints(resp *api.V1ProjectAdvisorsResponse) []Lint {
	var lints []Lint
	for _, l := range resp.Lints {
		lint := Lint{
			Name:        string(l.Name),
			Title:       l.Title,
			Level:       string(l.Level),
			Facing:      string(l.Facing),
			Description: l.Description,
			Detail:      l.Detail,
			Remediation: l.Remediation,
			CacheKey:    l.CacheKey,
		}
		for _, c := range l.Categories {
			lint.Categories = append(lint.Categories, string(c))
		}
		if l.Metadata != nil {
			data, err := json.Marshal(l.Metadata)
			if err == nil {
				raw := json.RawMessage(data)
				lint.Metadata = &raw
			}
		}
		lints = append(lints, lint)
	}
	return lints
}

func filterLints(lints []Lint, advisorType string, level string) []Lint {
	var filtered []Lint
	for _, l := range lints {
		if !matchesType(l, advisorType) {
			continue
		}
		if toEnum(l.Level) < toEnum(level) {
			continue
		}
		filtered = append(filtered, l)
	}
	return filtered
}

func matchesType(l Lint, advisorType string) bool {
	if advisorType == "all" {
		return true
	}
	for _, c := range l.Categories {
		switch {
		case advisorType == "security" && c == "SECURITY":
			return true
		case advisorType == "performance" && c == "PERFORMANCE":
			return true
		}
	}
	return false
}

func outputAndCheck(lints []Lint, failOn string, stdout io.Writer) error {
	if len(lints) == 0 {
		fmt.Fprintln(os.Stderr, "No issues found")
		return nil
	}

	enc := json.NewEncoder(stdout)
	enc.SetIndent("", "  ")
	if err := enc.Encode(lints); err != nil {
		return errors.Errorf("failed to print result json: %w", err)
	}

	failOnLevel := toEnum(failOn)
	if failOnLevel >= 0 {
		for _, l := range lints {
			if toEnum(l.Level) >= failOnLevel {
				return fmt.Errorf("fail-on is set to %s, non-zero exit", failOn)
			}
		}
	}
	return nil
}
