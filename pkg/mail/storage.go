package mail

import (
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/jhillyerd/enmime/v2"
)

// Storage provides file-based email storage.
// Emails are stored as .eml files organized by recipient mailbox.
//
// Storage format:
//
//	{base_path}/
//	└── {recipient-email}/
//	    └── {timestamp}-{id}.eml
type Storage struct {
	basePath string
	mu       sync.RWMutex
	counter  uint64
}

// NewStorage creates a new file-based storage at the given path.
func NewStorage(basePath string) (*Storage, error) {
	// Resolve to absolute path for consistent path validation
	absPath, err := filepath.Abs(basePath)
	if err != nil {
		return nil, fmt.Errorf("failed to resolve storage path: %w", err)
	}

	// Create the base directory if it doesn't exist
	if err := os.MkdirAll(absPath, 0755); err != nil {
		return nil, fmt.Errorf("failed to create storage directory: %w", err)
	}

	return &Storage{
		basePath: absPath,
	}, nil
}

// validatePath ensures that a path is within the storage base directory.
// This prevents path traversal attacks.
func (s *Storage) validatePath(path string) error {
	// Clean and resolve the path
	cleanPath := filepath.Clean(path)

	// Check if the path is within the base directory
	if !strings.HasPrefix(cleanPath, s.basePath+string(filepath.Separator)) && cleanPath != s.basePath {
		return fmt.Errorf("path traversal detected: path escapes storage directory")
	}

	return nil
}

// sanitizeID ensures the email ID doesn't contain path separators or other dangerous characters.
func sanitizeID(id string) string {
	// Remove any path separators and null bytes
	id = strings.ReplaceAll(id, "/", "")
	id = strings.ReplaceAll(id, "\\", "")
	id = strings.ReplaceAll(id, "\x00", "")
	id = strings.ReplaceAll(id, "..", "")
	return id
}

// Store saves an email for the given recipients.
func (s *Storage) Store(from string, to []string, data []byte) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	// Generate a unique ID based on timestamp and counter
	s.counter++
	timestamp := time.Now().UnixNano()
	id := fmt.Sprintf("%d-%d", timestamp, s.counter)

	// Store email for each recipient
	for _, recipient := range to {
		mailbox := sanitizeMailbox(recipient)
		mailboxPath := filepath.Join(s.basePath, mailbox)

		// Create mailbox directory if it doesn't exist
		if err := os.MkdirAll(mailboxPath, 0755); err != nil {
			return fmt.Errorf("failed to create mailbox directory: %w", err)
		}

		// Write the email as a .eml file
		filename := fmt.Sprintf("%s.eml", id)
		emailPath := filepath.Join(mailboxPath, filename)

		if err := os.WriteFile(emailPath, data, 0644); err != nil {
			return fmt.Errorf("failed to write email: %w", err)
		}
	}

	return nil
}

// ListMailboxes returns a list of all mailbox addresses.
func (s *Storage) ListMailboxes() ([]string, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()

	entries, err := os.ReadDir(s.basePath)
	if err != nil {
		if os.IsNotExist(err) {
			return []string{}, nil
		}
		return nil, fmt.Errorf("failed to read storage directory: %w", err)
	}

	var mailboxes []string
	for _, entry := range entries {
		if entry.IsDir() {
			mailboxes = append(mailboxes, entry.Name())
		}
	}

	sort.Strings(mailboxes)
	return mailboxes, nil
}

// ListEmails returns email summaries for the given mailbox.
func (s *Storage) ListEmails(mailbox string) ([]EmailSummary, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()

	mailbox = sanitizeMailbox(mailbox)
	mailboxPath := filepath.Join(s.basePath, mailbox)

	// Validate path stays within storage directory
	if err := s.validatePath(mailboxPath); err != nil {
		return nil, err
	}

	entries, err := os.ReadDir(mailboxPath)
	if err != nil {
		if os.IsNotExist(err) {
			return []EmailSummary{}, nil
		}
		return nil, fmt.Errorf("failed to read mailbox directory: %w", err)
	}

	var summaries []EmailSummary
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".eml") {
			continue
		}

		// Sanitize the filename to prevent path traversal
		filename := filepath.Base(entry.Name())
		id := strings.TrimSuffix(filename, ".eml")
		emailPath := filepath.Join(mailboxPath, filename)

		// Validate each email path
		if err := s.validatePath(emailPath); err != nil {
			continue
		}

		summary, err := s.parseEmailSummary(id, emailPath)
		if err != nil {
			// Skip emails that fail to parse
			continue
		}
		summaries = append(summaries, summary)
	}

	// Sort by date, newest first
	sort.Slice(summaries, func(i, j int) bool {
		return summaries[i].Date.After(summaries[j].Date)
	})

	return summaries, nil
}

// GetEmail returns the full email for the given mailbox and ID.
func (s *Storage) GetEmail(mailbox, id string) (*Email, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()

	mailbox = sanitizeMailbox(mailbox)
	id = sanitizeID(id)
	emailPath := filepath.Join(s.basePath, mailbox, id+".eml")

	// Validate path stays within storage directory
	if err := s.validatePath(emailPath); err != nil {
		return nil, fmt.Errorf("invalid email path: %w", err)
	}

	data, err := os.ReadFile(emailPath)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, fmt.Errorf("email not found: %s/%s", mailbox, id)
		}
		return nil, fmt.Errorf("failed to read email: %w", err)
	}

	return s.parseEmail(id, data)
}

// DeleteEmail deletes the email with the given ID from the mailbox.
func (s *Storage) DeleteEmail(mailbox, id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	mailbox = sanitizeMailbox(mailbox)
	id = sanitizeID(id)
	emailPath := filepath.Join(s.basePath, mailbox, id+".eml")

	// Validate path stays within storage directory
	if err := s.validatePath(emailPath); err != nil {
		return fmt.Errorf("invalid email path: %w", err)
	}

	if err := os.Remove(emailPath); err != nil {
		if os.IsNotExist(err) {
			return fmt.Errorf("email not found: %s/%s", mailbox, id)
		}
		return fmt.Errorf("failed to delete email: %w", err)
	}

	return nil
}

// DeleteMailbox deletes all emails in the given mailbox.
func (s *Storage) DeleteMailbox(mailbox string) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	mailbox = sanitizeMailbox(mailbox)
	mailboxPath := filepath.Join(s.basePath, mailbox)

	// Validate path stays within storage directory
	if err := s.validatePath(mailboxPath); err != nil {
		return fmt.Errorf("invalid mailbox path: %w", err)
	}

	if err := os.RemoveAll(mailboxPath); err != nil {
		return fmt.Errorf("failed to delete mailbox: %w", err)
	}

	return nil
}

// parseEmailSummary parses an email file and returns a summary.
// The path must already be validated before calling this function.
func (s *Storage) parseEmailSummary(id, path string) (EmailSummary, error) {
	// Additional safety check - validate path is within storage
	if err := s.validatePath(path); err != nil {
		return EmailSummary{}, err
	}

	file, err := os.Open(filepath.Clean(path))
	if err != nil {
		return EmailSummary{}, err
	}
	defer file.Close()

	info, err := file.Stat()
	if err != nil {
		return EmailSummary{}, err
	}

	env, err := enmime.ReadEnvelope(file)
	if err != nil {
		return EmailSummary{}, err
	}

	return EmailSummary{
		ID:      id,
		From:    env.GetHeader("From"),
		To:      parseAddressList(env.GetHeader("To")),
		Subject: env.GetHeader("Subject"),
		Date:    parseDate(env.GetHeader("Date")),
		Size:    info.Size(),
	}, nil
}

// parseEmail parses raw email data and returns the full email.
func (s *Storage) parseEmail(id string, data []byte) (*Email, error) {
	env, err := enmime.ReadEnvelope(strings.NewReader(string(data)))
	if err != nil {
		return nil, fmt.Errorf("failed to parse email: %w", err)
	}

	return &Email{
		EmailSummary: EmailSummary{
			ID:      id,
			From:    env.GetHeader("From"),
			To:      parseAddressList(env.GetHeader("To")),
			Subject: env.GetHeader("Subject"),
			Date:    parseDate(env.GetHeader("Date")),
			Size:    int64(len(data)),
		},
		TextBody: env.Text,
		HTMLBody: env.HTML,
		Raw:      data,
	}, nil
}

// sanitizeMailbox converts an email address to a safe directory name.
func sanitizeMailbox(addr string) string {
	// Remove angle brackets if present
	addr = strings.TrimPrefix(addr, "<")
	addr = strings.TrimSuffix(addr, ">")

	// Convert to lowercase for consistency
	addr = strings.ToLower(addr)

	// Replace potentially problematic characters
	addr = strings.ReplaceAll(addr, "/", "_")
	addr = strings.ReplaceAll(addr, "\\", "_")
	addr = strings.ReplaceAll(addr, ":", "_")
	addr = strings.ReplaceAll(addr, "*", "_")
	addr = strings.ReplaceAll(addr, "?", "_")
	addr = strings.ReplaceAll(addr, "\"", "_")
	addr = strings.ReplaceAll(addr, "<", "_")
	addr = strings.ReplaceAll(addr, ">", "_")
	addr = strings.ReplaceAll(addr, "|", "_")

	return addr
}

// parseAddressList parses a comma-separated list of email addresses.
func parseAddressList(header string) []string {
	if header == "" {
		return nil
	}

	parts := strings.Split(header, ",")
	var addrs []string
	for _, part := range parts {
		addr := strings.TrimSpace(part)
		if addr != "" {
			addrs = append(addrs, addr)
		}
	}
	return addrs
}

// parseDate attempts to parse a date header.
func parseDate(header string) time.Time {
	if header == "" {
		return time.Time{}
	}

	// Try common date formats
	formats := []string{
		time.RFC1123Z,
		time.RFC1123,
		time.RFC822Z,
		time.RFC822,
		"Mon, 2 Jan 2006 15:04:05 -0700",
		"Mon, 2 Jan 2006 15:04:05 MST",
		"2 Jan 2006 15:04:05 -0700",
		"2006-01-02T15:04:05-07:00",
	}

	for _, format := range formats {
		if t, err := time.Parse(format, header); err == nil {
			return t
		}
	}

	return time.Time{}
}

// StoreFromReader saves an email from a reader for the given recipients.
func (s *Storage) StoreFromReader(from string, to []string, r io.Reader) error {
	data, err := io.ReadAll(r)
	if err != nil {
		return fmt.Errorf("failed to read email data: %w", err)
	}
	return s.Store(from, to, data)
}
