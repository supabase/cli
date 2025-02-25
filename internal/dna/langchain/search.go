package langchain

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// SearchResult represents a PostgreSQL documentation search result
type SearchResult struct {
	Title   string `json:"title"`
	URL     string `json:"url"`
	Content string `json:"content"`
	Section string `json:"section"`
}

// SupabaseSearchResult represents a Supabase documentation search result
type SupabaseSearchResult struct {
	Title    string `json:"title"`
	URL      string `json:"url"`
	Content  string `json:"content"`
	Category string `json:"category"`
}

// SearchPostgresDocs searches PostgreSQL documentation and returns top results
func SearchPostgresDocs(ctx context.Context, query string, limit int) ([]SearchResult, error) {
	// Build search URL
	baseURL := "https://www.postgresql.org/search/"
	params := url.Values{}
	params.Add("q", query)
	params.Add("u", "/docs/17/") // Search in latest docs
	params.Add("fmt", "json")    // Request JSON response
	params.Add("limit", fmt.Sprintf("%d", limit))

	// Create request
	req, err := http.NewRequestWithContext(ctx, "GET", baseURL+"?"+params.Encode(), nil)
	if err != nil {
		return nil, fmt.Errorf("failed to create request: %w", err)
	}

	// Send request
	client := &http.Client{}
	resp, err := client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("failed to send request: %w", err)
	}
	defer resp.Body.Close()

	// Read response
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("failed to read response: %w", err)
	}

	// Parse results
	var results []SearchResult
	if err := json.Unmarshal(body, &results); err != nil {
		return nil, fmt.Errorf("failed to parse response: %w", err)
	}

	return results, nil
}

// SearchSupabaseDocs searches Supabase documentation and returns top results
func SearchSupabaseDocs(ctx context.Context, query string, limit int) ([]SupabaseSearchResult, error) {
	// Base URLs for Supabase documentation
	baseURLs := []string{
		"https://supabase.com/docs/guides/database",
		"https://supabase.com/docs/guides/auth",
		"https://supabase.com/docs/guides/functions",
		"https://supabase.com/docs/guides/realtime",
	}

	// Create HTTP client with context
	client := &http.Client{}

	var results []SupabaseSearchResult
	for _, baseURL := range baseURLs {
		// Create request
		req, err := http.NewRequestWithContext(ctx, "GET", baseURL, nil)
		if err != nil {
			continue // Skip if we can't access this section
		}

		// Send request
		resp, err := client.Do(req)
		if err != nil {
			continue
		}
		defer resp.Body.Close()

		// Read response
		body, err := io.ReadAll(resp.Body)
		if err != nil {
			continue
		}

		// Extract relevant content (this is a simplified version)
		// In a real implementation, we would parse the HTML and extract structured content
		category := strings.TrimPrefix(baseURL, "https://supabase.com/docs/guides/")
		results = append(results, SupabaseSearchResult{
			Title:    fmt.Sprintf("Supabase %s Guide", strings.Title(category)),
			URL:      baseURL,
			Content:  string(body),
			Category: category,
		})

		if len(results) >= limit {
			break
		}
	}

	return results, nil
}

// AddSearchResultToRAG adds a search result to the RAG system
func (r *RAG) AddSearchResultToRAG(ctx context.Context, result SearchResult) error {
	source := Source{
		Title:  result.Title,
		URL:    result.URL,
		Author: "PostgreSQL Global Development Group",
		Date:   "PostgreSQL 17",
	}

	return r.AddKnowledgeSource(ctx, result.Content, source, []string{
		"postgresql_docs",
		"search_result",
		result.Section,
	})
}

// AddSupabaseSearchResultToRAG adds a Supabase search result to the RAG system
func (r *RAG) AddSupabaseSearchResultToRAG(ctx context.Context, result SupabaseSearchResult) error {
	source := Source{
		Title:  result.Title,
		URL:    result.URL,
		Author: "Supabase",
		Date:   time.Now().Format("2006-01-02"), // Current date as docs are regularly updated
	}

	return r.AddKnowledgeSource(ctx, result.Content, source, []string{
		"supabase_docs",
		"search_result",
		result.Category,
	})
}

// SearchAndAddToRAG searches PostgreSQL docs and adds results to RAG
func (r *RAG) SearchAndAddToRAG(ctx context.Context, query string, limit int) error {
	// Search docs
	results, err := SearchPostgresDocs(ctx, query, limit)
	if err != nil {
		return fmt.Errorf("search failed: %w", err)
	}

	// Add each result to RAG
	for _, result := range results {
		if err := r.AddSearchResultToRAG(ctx, result); err != nil {
			return fmt.Errorf("failed to add result to RAG: %w", err)
		}
	}

	return nil
}

// SearchAndAddSupabaseToRAG searches Supabase docs and adds results to RAG
func (r *RAG) SearchAndAddSupabaseToRAG(ctx context.Context, query string, limit int) error {
	// Search docs
	results, err := SearchSupabaseDocs(ctx, query, limit)
	if err != nil {
		return fmt.Errorf("search failed: %w", err)
	}

	// Add each result to RAG
	for _, result := range results {
		if err := r.AddSupabaseSearchResultToRAG(ctx, result); err != nil {
			return fmt.Errorf("failed to add result to RAG: %w", err)
		}
	}

	return nil
}

// Example usage:
func ExampleSearchAndAdd(ctx context.Context, r *RAG) error {
	// Search for normalization-related docs and add top 3 results
	if err := r.SearchAndAddToRAG(ctx, "database normalization best practices", 3); err != nil {
		return err
	}

	// Search for specific topics
	queries := []string{
		"table relationships many-to-many",
		"database constraints foreign keys",
		"indexing strategy",
	}

	for _, query := range queries {
		if err := r.SearchAndAddToRAG(ctx, query, 2); err != nil {
			return err
		}
	}

	return nil
}

func ExampleSearchSupabase(ctx context.Context, r *RAG) error {
	// Search for database-related docs and add top 3 results
	if err := r.SearchAndAddSupabaseToRAG(ctx, "row level security best practices", 3); err != nil {
		return err
	}

	// Search for specific topics
	queries := []string{
		"foreign key relationships",
		"database functions",
		"real-time subscriptions",
	}

	for _, query := range queries {
		if err := r.SearchAndAddSupabaseToRAG(ctx, query, 2); err != nil {
			return err
		}
	}

	return nil
}
