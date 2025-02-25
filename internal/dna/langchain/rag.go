package langchain

import (
	"context"
	"fmt"
	"strings"

	"github.com/tmc/langchaingo/embeddings"
	"github.com/tmc/langchaingo/embeddings/openai"
	"github.com/tmc/langchaingo/llms"
	"github.com/tmc/langchaingo/schema"
	"github.com/tmc/langchaingo/vectorstores"
)

// Document represents a piece of documentation
type Document struct {
	Content  string
	Metadata map[string]interface{}
}

// Source represents a knowledge source
type Source struct {
	Title  string
	URL    string
	Author string
	Date   string
}

// DocumentWithSource adds source attribution to a document
type DocumentWithSource struct {
	Document
	Source Source
}

// RAG handles retrieval augmented generation
type RAG struct {
	store      vectorstores.VectorStore
	embedder   embeddings.Embedder
	documents  []Document
	chunkSize  int
	numResults int
}

// PostgreSQLDoc represents an official PostgreSQL documentation section
type PostgreSQLDoc struct {
	Source
	Chapter string
	Section string
	Version string
}

// NewRAG creates a new RAG instance
func NewRAG(apiKey string) (*RAG, error) {
	embedder := openai.NewEmbedder(apiKey)

	// Initialize with some basic documentation
	docs := []Document{
		{
			Content: `Database normalization is the process of structuring a database to reduce data redundancy and improve data integrity.

First Normal Form (1NF):
- Each table cell should contain a single value (atomic values)
- Each record needs to be unique
- No repeating groups or arrays
- Example: Instead of storing comma-separated categories in a 'tags' column, create a separate tags table`,
			Metadata: map[string]interface{}{
				"type": "normalization",
				"form": "1NF",
			},
		},
		{
			Content: `Second Normal Form (2NF):
- Must be in 1NF
- All non-key attributes are fully dependent on the primary key
- No partial dependencies
- Example: In a product_orders table, if order_date depends only on order_id (not product_id), it should be in a separate orders table`,
			Metadata: map[string]interface{}{
				"type": "normalization",
				"form": "2NF",
			},
		},
		{
			Content: `Third Normal Form (3NF):
- Must be in 2NF
- No transitive dependencies
- All fields must depend directly on the primary key
- Example: If product_category_name depends on category_id which depends on product_id, move category data to a separate table`,
			Metadata: map[string]interface{}{
				"type": "normalization",
				"form": "3NF",
			},
		},
		{
			Content: `Complex Relationships in PostgreSQL:
For handling complex relationships like products belonging to multiple categories:

1. Use bridge tables for many-to-many relationships:
CREATE TABLE products (
    product_id SERIAL PRIMARY KEY,
    name VARCHAR(255),
    base_price DECIMAL(10,2)
);

CREATE TABLE categories (
    category_id SERIAL PRIMARY KEY,
    name VARCHAR(255)
);

CREATE TABLE product_categories (
    product_id INTEGER REFERENCES products(product_id),
    category_id INTEGER REFERENCES categories(category_id),
    PRIMARY KEY (product_id, category_id)
);`,
			Metadata: map[string]interface{}{
				"type":  "implementation",
				"topic": "relationships",
			},
		},
		{
			Content: `Performance Optimization with Normalized Data:
1. Create indexes on frequently joined columns:
CREATE INDEX idx_product_categories_product_id ON product_categories(product_id);
CREATE INDEX idx_product_categories_category_id ON product_categories(category_id);

2. Use materialized views for complex queries that don't need real-time data:
CREATE MATERIALIZED VIEW product_category_summary AS
SELECT p.name AS product_name,
       string_agg(c.name, ', ') AS categories,
       p.base_price
FROM products p
JOIN product_categories pc ON p.product_id = pc.product_id
JOIN categories c ON pc.category_id = c.category_id
GROUP BY p.product_id, p.name, p.base_price;`,
			Metadata: map[string]interface{}{
				"type":  "optimization",
				"topic": "performance",
			},
		},
		{
			Content: `Constraint Management in PostgreSQL:
Use PostgreSQL's constraint system to maintain data integrity:

1. Check constraints for business rules:
ALTER TABLE products 
ADD CONSTRAINT price_check 
CHECK (base_price >= 0);

2. Unique constraints for data uniqueness:
ALTER TABLE categories 
ADD CONSTRAINT unique_category_name 
UNIQUE (name);

3. Foreign key constraints for referential integrity:
ALTER TABLE product_categories 
ADD CONSTRAINT fk_product 
FOREIGN KEY (product_id) 
REFERENCES products(product_id) 
ON DELETE CASCADE;`,
			Metadata: map[string]interface{}{
				"type":  "implementation",
				"topic": "constraints",
			},
		},
		{
			Content: `When to Consider Denormalization:
1. When query performance is critical and joins are expensive
2. For read-heavy workloads with infrequent updates
3. When maintaining real-time aggregations
4. For time-series data with specific access patterns

Note: Always measure performance impact before denormalizing.`,
			Metadata: map[string]interface{}{
				"type":  "optimization",
				"topic": "denormalization",
			},
		},
		{
			Content: `Supabase Row Level Security (RLS):
- Control access to rows in database tables
- Define policies using SQL
- Automatically applied to all queries
- Essential for multi-tenant applications
- Integrates with Supabase Auth`,
			Metadata: map[string]interface{}{
				"type":    "supabase",
				"feature": "rls",
			},
		},
	}

	// Create vector store
	store := vectorstores.NewMemory(embedder)

	rag := &RAG{
		store:      store,
		embedder:   embedder,
		documents:  docs,
		chunkSize:  500,
		numResults: 3,
	}

	// Add documents to store
	if err := rag.initializeStore(); err != nil {
		return nil, err
	}

	return rag, nil
}

// initializeStore adds all documents to the vector store
func (r *RAG) initializeStore() error {
	for _, doc := range r.documents {
		chunks := r.chunkText(doc.Content)
		for _, chunk := range chunks {
			_, err := r.store.AddDocuments(context.Background(), []schema.Document{
				{
					PageContent: chunk,
					Metadata:    doc.Metadata,
				},
			})
			if err != nil {
				return fmt.Errorf("failed to add document to store: %w", err)
			}
		}
	}
	return nil
}

// chunkText splits text into smaller chunks
func (r *RAG) chunkText(text string) []string {
	words := strings.Fields(text)
	var chunks []string
	for i := 0; i < len(words); i += r.chunkSize {
		end := i + r.chunkSize
		if end > len(words) {
			end = len(words)
		}
		chunks = append(chunks, strings.Join(words[i:end], " "))
	}
	return chunks
}

// Query searches for relevant documents and augments the prompt
func (r *RAG) Query(ctx context.Context, query string, llm llms.LLM) (string, error) {
	// First, search both PostgreSQL and Supabase docs for relevant content
	searchErrors := make([]error, 0)

	// Search PostgreSQL docs
	if err := r.SearchAndAddToRAG(ctx, query, 3); err != nil {
		searchErrors = append(searchErrors, fmt.Errorf("PostgreSQL search failed: %w", err))
	}

	// Search Supabase docs
	if err := r.SearchAndAddSupabaseToRAG(ctx, query, 3); err != nil {
		searchErrors = append(searchErrors, fmt.Errorf("Supabase search failed: %w", err))
	}

	// Log search errors but continue - we still have our base knowledge
	if len(searchErrors) > 0 {
		fmt.Println("Warning: Some documentation searches failed:")
		for _, err := range searchErrors {
			fmt.Printf("- %v\n", err)
		}
	}

	// Search for relevant documents in our knowledge base
	results, err := r.store.SimilaritySearch(ctx, query, r.numResults)
	if err != nil {
		return "", fmt.Errorf("similarity search failed: %w", err)
	}

	// Build augmented prompt
	var relevantDocs strings.Builder
	for _, doc := range results {
		relevantDocs.WriteString(doc.PageContent)
		if metadata, ok := doc.Metadata["source"].(Source); ok {
			relevantDocs.WriteString(fmt.Sprintf("\n\nSource: %s (%s)", metadata.Title, metadata.URL))
		}
		relevantDocs.WriteString("\n\n")
	}

	// Create augmented prompt
	augmentedPrompt := fmt.Sprintf(`Based on the following documentation:

%s

Answer this question: %s

Provide specific examples and references to the documentation where relevant. If you're referencing Supabase-specific features, make sure to explain how they relate to standard PostgreSQL concepts.`, relevantDocs.String(), query)

	// Get response from LLM
	messages := []schema.ChatMessage{
		&schema.SystemMessage{Content: "You are a database design expert focusing on PostgreSQL and Supabase. Explain concepts clearly and provide practical examples."},
		&schema.HumanMessage{Content: augmentedPrompt},
	}

	completion, err := llm.GenerateContent(ctx, messages, llms.WithTemperature(0.7))
	if err != nil {
		return "", fmt.Errorf("LLM call failed: %w", err)
	}

	return completion.Content, nil
}

// AddDocument adds a new document to the RAG system
func (r *RAG) AddDocument(ctx context.Context, doc Document) error {
	r.documents = append(r.documents, doc)
	chunks := r.chunkText(doc.Content)
	for _, chunk := range chunks {
		_, err := r.store.AddDocuments(ctx, []schema.Document{
			{
				PageContent: chunk,
				Metadata:    doc.Metadata,
			},
		})
		if err != nil {
			return fmt.Errorf("failed to add document to store: %w", err)
		}
	}
	return nil
}

// AddKnowledgeSource adds a new knowledge source with proper attribution
func (r *RAG) AddKnowledgeSource(ctx context.Context, content string, source Source, topics []string) error {
	// Create metadata with source information and topics
	metadata := map[string]interface{}{
		"source": source,
		"topics": topics,
	}

	// Add the document with source attribution
	return r.AddDocument(ctx, Document{
		Content:  content,
		Metadata: metadata,
	})
}

// AddPostgreSQLDoc adds official PostgreSQL documentation with proper structure
func (r *RAG) AddPostgreSQLDoc(ctx context.Context, doc PostgreSQLDoc, content string) error {
	source := Source{
		Title:  fmt.Sprintf("PostgreSQL %s: %s - %s", doc.Version, doc.Chapter, doc.Section),
		URL:    fmt.Sprintf("https://www.postgresql.org/docs/%s/%s.html", doc.Version, strings.ToLower(strings.ReplaceAll(doc.Chapter, " ", "-"))),
		Author: "PostgreSQL Global Development Group",
		Date:   fmt.Sprintf("PostgreSQL %s", doc.Version),
	}

	metadata := map[string]interface{}{
		"source":      source,
		"type":        "postgresql_docs",
		"version":     doc.Version,
		"chapter":     doc.Chapter,
		"section":     doc.Section,
		"is_official": true,
	}

	return r.AddDocument(ctx, Document{
		Content:  content,
		Metadata: metadata,
	})
}

// Example usage:
func ExampleAddTimescaleArticle(ctx context.Context, r *RAG) error {
	source := Source{
		Title:  "How to Use PostgreSQL for Data Normalization",
		URL:    "https://www.timescale.com/learn/how-to-use-postgresql-for-data-normalization",
		Author: "Timescale",
		Date:   "2024",
	}

	content := `Handling Complex Relationships in PostgreSQL:
When it comes to data normalization in PostgreSQL, managing complex relationships between different entities is one of the most significant challenges. For example, in an e-commerce platform where products can belong to multiple categories and have various attributes:

Best Practices:
1. Use bridge tables for many-to-many relationships
2. Implement appropriate indexing strategies
3. Use materialized views for complex, frequently-accessed data
4. Apply constraints to maintain data integrity

Performance Considerations:
- Create indexes on frequently joined columns
- Use materialized views for complex queries that don't need real-time data
- Consider denormalization only when necessary and after measuring performance impact

When to Consider Denormalization:
1. For read-heavy workloads with infrequent updates
2. When query performance is critical
3. For time-series data with specific access patterns
4. When maintaining real-time aggregations

Always validate the impact of denormalization through testing and measurement.`

	return r.AddKnowledgeSource(ctx, content, source, []string{
		"normalization",
		"relationships",
		"performance",
		"postgresql",
		"denormalization",
	})
}

func ExampleAddPostgreSQLNormalizationDocs(ctx context.Context, r *RAG) error {
	// Add Database Design chapter
	doc := PostgreSQLDoc{
		Version: "17",
		Chapter: "Database Design",
		Section: "Data Modeling",
	}

	content := `Database Design Principles in PostgreSQL:

Table Design Guidelines:
1. Choose the right data types
2. Normalize data appropriately
3. Use constraints to enforce data integrity
4. Consider indexing strategy from the start

Normalization Guidelines:
- Break down tables to eliminate redundancy
- Ensure each column serves a single purpose
- Use foreign keys to maintain relationships
- Consider the impact on query performance

PostgreSQL-specific features for better design:
- JSONB for semi-structured data
- Array types when appropriate
- Inheritance for table hierarchies
- Partitioning for large tables`

	return r.AddPostgreSQLDoc(ctx, doc, content)
}
