package mail

import (
	"context"
	"fmt"
	"net/smtp"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestNewServer(t *testing.T) {
	t.Run("creates server with default config", func(t *testing.T) {
		tmpDir := t.TempDir()
		server, err := NewServer(Config{StoragePath: tmpDir})
		require.NoError(t, err)
		assert.NotNil(t, server)
	})

	t.Run("uses SUPABASE_MAIL_PATH env var", func(t *testing.T) {
		tmpDir := t.TempDir()
		t.Setenv("SUPABASE_MAIL_PATH", tmpDir)

		server, err := NewServer(Config{})
		require.NoError(t, err)
		assert.NotNil(t, server)
	})

	t.Run("uses default path when no config", func(t *testing.T) {
		// Save current env
		oldPath := os.Getenv("SUPABASE_MAIL_PATH")
		os.Unsetenv("SUPABASE_MAIL_PATH")
		defer func() {
			if oldPath != "" {
				os.Setenv("SUPABASE_MAIL_PATH", oldPath)
			}
		}()

		server, err := NewServer(Config{})
		require.NoError(t, err)
		assert.NotNil(t, server)
	})
}

func TestServerStartStop(t *testing.T) {
	tmpDir := t.TempDir()
	server, err := NewServer(Config{
		Host:        "127.0.0.1",
		Port:        0, // Let the OS assign a port
		StoragePath: tmpDir,
	})
	require.NoError(t, err)

	ctx, cancel := context.WithCancel(context.Background())
	errCh := make(chan error, 1)

	// Start server in background
	go func() {
		errCh <- server.Start(ctx)
	}()

	// Give server time to start
	time.Sleep(100 * time.Millisecond)

	// Stop the server
	cancel()

	// Wait for server to stop
	select {
	case err := <-errCh:
		assert.ErrorIs(t, err, context.Canceled)
	case <-time.After(5 * time.Second):
		t.Fatal("server did not stop in time")
	}
}

func TestStorage(t *testing.T) {
	tmpDir := t.TempDir()
	storage, err := NewStorage(tmpDir)
	require.NoError(t, err)

	t.Run("store and retrieve email", func(t *testing.T) {
		emailData := createTestEmail("sender@example.com", "recipient@example.com", "Test Subject", "Test Body")

		err := storage.Store("sender@example.com", []string{"recipient@example.com"}, emailData)
		require.NoError(t, err)

		// List mailboxes
		mailboxes, err := storage.ListMailboxes()
		require.NoError(t, err)
		assert.Contains(t, mailboxes, "recipient@example.com")

		// List emails
		emails, err := storage.ListEmails("recipient@example.com")
		require.NoError(t, err)
		require.Len(t, emails, 1)
		assert.Equal(t, "Test Subject", emails[0].Subject)

		// Get email
		email, err := storage.GetEmail("recipient@example.com", emails[0].ID)
		require.NoError(t, err)
		assert.Equal(t, "Test Subject", email.Subject)
		assert.Contains(t, email.TextBody, "Test Body")
	})

	t.Run("store email to multiple recipients", func(t *testing.T) {
		emailData := createTestEmail("sender@example.com", "user1@example.com", "Multi Recipient", "Body")

		err := storage.Store("sender@example.com", []string{"user1@example.com", "user2@example.com"}, emailData)
		require.NoError(t, err)

		// Both mailboxes should exist
		mailboxes, err := storage.ListMailboxes()
		require.NoError(t, err)
		assert.Contains(t, mailboxes, "user1@example.com")
		assert.Contains(t, mailboxes, "user2@example.com")
	})

	t.Run("delete email", func(t *testing.T) {
		emailData := createTestEmail("sender@example.com", "delete@example.com", "To Delete", "Body")

		err := storage.Store("sender@example.com", []string{"delete@example.com"}, emailData)
		require.NoError(t, err)

		emails, err := storage.ListEmails("delete@example.com")
		require.NoError(t, err)
		require.Len(t, emails, 1)

		err = storage.DeleteEmail("delete@example.com", emails[0].ID)
		require.NoError(t, err)

		emails, err = storage.ListEmails("delete@example.com")
		require.NoError(t, err)
		assert.Len(t, emails, 0)
	})

	t.Run("delete mailbox", func(t *testing.T) {
		emailData := createTestEmail("sender@example.com", "deletemailbox@example.com", "Test", "Body")

		err := storage.Store("sender@example.com", []string{"deletemailbox@example.com"}, emailData)
		require.NoError(t, err)

		err = storage.DeleteMailbox("deletemailbox@example.com")
		require.NoError(t, err)

		mailboxes, err := storage.ListMailboxes()
		require.NoError(t, err)
		assert.NotContains(t, mailboxes, "deletemailbox@example.com")
	})

	t.Run("get non-existent email", func(t *testing.T) {
		_, err := storage.GetEmail("nonexistent@example.com", "nonexistent-id")
		assert.Error(t, err)
	})

	t.Run("delete non-existent email", func(t *testing.T) {
		err := storage.DeleteEmail("nonexistent@example.com", "nonexistent-id")
		assert.Error(t, err)
	})

	t.Run("list empty mailbox", func(t *testing.T) {
		emails, err := storage.ListEmails("empty@example.com")
		require.NoError(t, err)
		assert.Empty(t, emails)
	})
}

func TestSanitizeMailbox(t *testing.T) {
	tests := []struct {
		input    string
		expected string
	}{
		{"user@example.com", "user@example.com"},
		{"<user@example.com>", "user@example.com"},
		{"USER@EXAMPLE.COM", "user@example.com"},
		{"user/test@example.com", "user_test@example.com"},
		{"user:test@example.com", "user_test@example.com"},
		{"user*test@example.com", "user_test@example.com"},
	}

	for _, tt := range tests {
		t.Run(tt.input, func(t *testing.T) {
			result := sanitizeMailbox(tt.input)
			assert.Equal(t, tt.expected, result)
		})
	}
}

func TestParseAddressList(t *testing.T) {
	tests := []struct {
		input    string
		expected []string
	}{
		{"", nil},
		{"user@example.com", []string{"user@example.com"}},
		{"user1@example.com, user2@example.com", []string{"user1@example.com", "user2@example.com"}},
		{"  user1@example.com  ,  user2@example.com  ", []string{"user1@example.com", "user2@example.com"}},
	}

	for _, tt := range tests {
		t.Run(tt.input, func(t *testing.T) {
			result := parseAddressList(tt.input)
			assert.Equal(t, tt.expected, result)
		})
	}
}

func TestParseDate(t *testing.T) {
	tests := []struct {
		input string
		valid bool
	}{
		{"", false},
		{"Mon, 02 Jan 2006 15:04:05 -0700", true},
		{"Mon, 2 Jan 2006 15:04:05 MST", true},
		{"invalid date", false},
	}

	for _, tt := range tests {
		t.Run(tt.input, func(t *testing.T) {
			result := parseDate(tt.input)
			if tt.valid {
				assert.False(t, result.IsZero())
			} else {
				assert.True(t, result.IsZero())
			}
		})
	}
}

func TestSMTPIntegration(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping integration test")
	}

	tmpDir := t.TempDir()
	server, err := NewServer(Config{
		Host:        "127.0.0.1",
		Port:        54399, // Use a specific port for testing
		StoragePath: tmpDir,
	})
	require.NoError(t, err)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	errCh := make(chan error, 1)
	go func() {
		errCh <- server.Start(ctx)
	}()

	// Wait for server to start
	time.Sleep(200 * time.Millisecond)

	// Send an email via SMTP
	from := "sender@example.com"
	to := []string{"recipient@example.com"}
	msg := []byte("From: sender@example.com\r\n" +
		"To: recipient@example.com\r\n" +
		"Subject: Integration Test\r\n" +
		"Date: Mon, 02 Jan 2006 15:04:05 -0700\r\n" +
		"\r\n" +
		"This is a test email body.\r\n")

	err = smtp.SendMail("127.0.0.1:54399", nil, from, to, msg)
	require.NoError(t, err)

	// Give storage time to write
	time.Sleep(100 * time.Millisecond)

	// Verify email was stored
	mailboxes, err := server.ListMailboxes()
	require.NoError(t, err)
	assert.Contains(t, mailboxes, "recipient@example.com")

	emails, err := server.ListEmails("recipient@example.com")
	require.NoError(t, err)
	require.Len(t, emails, 1)
	assert.Equal(t, "Integration Test", emails[0].Subject)

	// Get full email
	email, err := server.GetEmail("recipient@example.com", emails[0].ID)
	require.NoError(t, err)
	assert.Contains(t, email.TextBody, "test email body")

	// Delete email
	err = server.DeleteEmail("recipient@example.com", emails[0].ID)
	require.NoError(t, err)

	emails, err = server.ListEmails("recipient@example.com")
	require.NoError(t, err)
	assert.Len(t, emails, 0)

	// Stop server
	cancel()
	select {
	case <-errCh:
	case <-time.After(5 * time.Second):
		t.Fatal("server did not stop in time")
	}
}

func TestStorageFilePersistence(t *testing.T) {
	tmpDir := t.TempDir()

	// Create storage and store email
	storage1, err := NewStorage(tmpDir)
	require.NoError(t, err)

	emailData := createTestEmail("sender@example.com", "persist@example.com", "Persistence Test", "Body")
	err = storage1.Store("sender@example.com", []string{"persist@example.com"}, emailData)
	require.NoError(t, err)

	emails1, err := storage1.ListEmails("persist@example.com")
	require.NoError(t, err)
	require.Len(t, emails1, 1)
	emailID := emails1[0].ID

	// Create new storage instance pointing to same directory
	storage2, err := NewStorage(tmpDir)
	require.NoError(t, err)

	// Verify email is still accessible
	mailboxes, err := storage2.ListMailboxes()
	require.NoError(t, err)
	assert.Contains(t, mailboxes, "persist@example.com")

	emails2, err := storage2.ListEmails("persist@example.com")
	require.NoError(t, err)
	require.Len(t, emails2, 1)
	assert.Equal(t, emailID, emails2[0].ID)

	// Verify .eml file exists
	emlPath := filepath.Join(tmpDir, "persist@example.com", emailID+".eml")
	_, err = os.Stat(emlPath)
	require.NoError(t, err)
}

// createTestEmail creates a simple RFC 5322 email
func createTestEmail(from, to, subject, body string) []byte {
	date := time.Now().Format(time.RFC1123Z)
	msg := fmt.Sprintf("From: %s\r\n"+
		"To: %s\r\n"+
		"Subject: %s\r\n"+
		"Date: %s\r\n"+
		"MIME-Version: 1.0\r\n"+
		"Content-Type: text/plain; charset=utf-8\r\n"+
		"\r\n"+
		"%s\r\n", from, to, subject, date, body)
	return []byte(msg)
}

func TestServerDoubleStart(t *testing.T) {
	tmpDir := t.TempDir()
	server, err := NewServer(Config{
		Host:        "127.0.0.1",
		Port:        54398,
		StoragePath: tmpDir,
	})
	require.NoError(t, err)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	// Start server
	go func() {
		server.Start(ctx)
	}()

	time.Sleep(100 * time.Millisecond)

	// Try to start again - should return error
	ctx2, cancel2 := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel2()
	err = server.Start(ctx2)
	assert.Error(t, err)
	assert.Contains(t, err.Error(), "already running")
}

func TestServerAddr(t *testing.T) {
	tmpDir := t.TempDir()
	server, err := NewServer(Config{
		Host:        "127.0.0.1",
		Port:        54397,
		StoragePath: tmpDir,
	})
	require.NoError(t, err)

	// Before starting, returns configured address
	assert.Equal(t, "127.0.0.1:54397", server.Addr())

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	go func() {
		server.Start(ctx)
	}()

	time.Sleep(100 * time.Millisecond)

	// After starting, returns actual listening address
	addr := server.Addr()
	assert.True(t, strings.Contains(addr, "127.0.0.1"))
}

func TestEmailSummaryFields(t *testing.T) {
	tmpDir := t.TempDir()
	storage, err := NewStorage(tmpDir)
	require.NoError(t, err)

	// Create email with various headers
	emailData := []byte("From: Sender Name <sender@example.com>\r\n" +
		"To: Recipient Name <recipient@example.com>\r\n" +
		"Subject: Test Email with Headers\r\n" +
		"Date: Mon, 02 Jan 2006 15:04:05 -0700\r\n" +
		"MIME-Version: 1.0\r\n" +
		"Content-Type: text/plain; charset=utf-8\r\n" +
		"\r\n" +
		"Email body content.\r\n")

	err = storage.Store("sender@example.com", []string{"recipient@example.com"}, emailData)
	require.NoError(t, err)

	emails, err := storage.ListEmails("recipient@example.com")
	require.NoError(t, err)
	require.Len(t, emails, 1)

	summary := emails[0]
	assert.NotEmpty(t, summary.ID)
	assert.Equal(t, "Sender Name <sender@example.com>", summary.From)
	assert.Equal(t, []string{"Recipient Name <recipient@example.com>"}, summary.To)
	assert.Equal(t, "Test Email with Headers", summary.Subject)
	assert.False(t, summary.Date.IsZero())
	assert.Greater(t, summary.Size, int64(0))
}

func TestHTMLEmail(t *testing.T) {
	tmpDir := t.TempDir()
	storage, err := NewStorage(tmpDir)
	require.NoError(t, err)

	// Create multipart email with HTML content
	emailData := []byte("From: sender@example.com\r\n" +
		"To: recipient@example.com\r\n" +
		"Subject: HTML Email Test\r\n" +
		"Date: Mon, 02 Jan 2006 15:04:05 -0700\r\n" +
		"MIME-Version: 1.0\r\n" +
		"Content-Type: multipart/alternative; boundary=\"boundary123\"\r\n" +
		"\r\n" +
		"--boundary123\r\n" +
		"Content-Type: text/plain; charset=utf-8\r\n" +
		"\r\n" +
		"Plain text version\r\n" +
		"--boundary123\r\n" +
		"Content-Type: text/html; charset=utf-8\r\n" +
		"\r\n" +
		"<html><body><h1>HTML version</h1></body></html>\r\n" +
		"--boundary123--\r\n")

	err = storage.Store("sender@example.com", []string{"htmltest@example.com"}, emailData)
	require.NoError(t, err)

	emails, err := storage.ListEmails("htmltest@example.com")
	require.NoError(t, err)
	require.Len(t, emails, 1)

	email, err := storage.GetEmail("htmltest@example.com", emails[0].ID)
	require.NoError(t, err)
	assert.Contains(t, email.TextBody, "Plain text version")
	assert.Contains(t, email.HTMLBody, "<h1>HTML version</h1>")
}

func TestStoreFromReader(t *testing.T) {
	tmpDir := t.TempDir()
	storage, err := NewStorage(tmpDir)
	require.NoError(t, err)

	emailData := createTestEmail("sender@example.com", "reader@example.com", "Reader Test", "Body from reader")
	reader := strings.NewReader(string(emailData))

	err = storage.StoreFromReader("sender@example.com", []string{"reader@example.com"}, reader)
	require.NoError(t, err)

	emails, err := storage.ListEmails("reader@example.com")
	require.NoError(t, err)
	require.Len(t, emails, 1)
	assert.Equal(t, "Reader Test", emails[0].Subject)
}

func TestServerStopIdempotent(t *testing.T) {
	tmpDir := t.TempDir()
	server, err := NewServer(Config{
		Host:        "127.0.0.1",
		Port:        54396,
		StoragePath: tmpDir,
	})
	require.NoError(t, err)

	// Stop without starting should not error
	err = server.Stop()
	assert.NoError(t, err)

	// Multiple stops should not error
	err = server.Stop()
	assert.NoError(t, err)
}

func TestServerDeleteMailbox(t *testing.T) {
	tmpDir := t.TempDir()
	server, err := NewServer(Config{StoragePath: tmpDir})
	require.NoError(t, err)

	// Store some emails
	emailData := createTestEmail("sender@example.com", "todelete@example.com", "Test", "Body")
	err = server.storage.Store("sender@example.com", []string{"todelete@example.com"}, emailData)
	require.NoError(t, err)

	// Verify mailbox exists
	mailboxes, err := server.ListMailboxes()
	require.NoError(t, err)
	assert.Contains(t, mailboxes, "todelete@example.com")

	// Delete via server API
	err = server.DeleteMailbox("todelete@example.com")
	require.NoError(t, err)

	// Verify mailbox is gone
	mailboxes, err = server.ListMailboxes()
	require.NoError(t, err)
	assert.NotContains(t, mailboxes, "todelete@example.com")
}

func TestEmailRawContent(t *testing.T) {
	tmpDir := t.TempDir()
	storage, err := NewStorage(tmpDir)
	require.NoError(t, err)

	originalData := createTestEmail("sender@example.com", "raw@example.com", "Raw Test", "Original body")
	err = storage.Store("sender@example.com", []string{"raw@example.com"}, originalData)
	require.NoError(t, err)

	emails, err := storage.ListEmails("raw@example.com")
	require.NoError(t, err)
	require.Len(t, emails, 1)

	email, err := storage.GetEmail("raw@example.com", emails[0].ID)
	require.NoError(t, err)

	// Raw content should be preserved
	assert.Equal(t, originalData, email.Raw)
}

func TestMultipleEmailsInMailbox(t *testing.T) {
	tmpDir := t.TempDir()
	storage, err := NewStorage(tmpDir)
	require.NoError(t, err)

	// Store multiple emails to same mailbox
	for i := 1; i <= 5; i++ {
		emailData := createTestEmail("sender@example.com", "multi@example.com",
			fmt.Sprintf("Email %d", i), fmt.Sprintf("Body %d", i))
		err = storage.Store("sender@example.com", []string{"multi@example.com"}, emailData)
		require.NoError(t, err)
		// Small delay to ensure different timestamps
		time.Sleep(10 * time.Millisecond)
	}

	emails, err := storage.ListEmails("multi@example.com")
	require.NoError(t, err)
	assert.Len(t, emails, 5)

	// Emails should be sorted by date (newest first)
	for i := 0; i < len(emails)-1; i++ {
		assert.True(t, emails[i].Date.After(emails[i+1].Date) || emails[i].Date.Equal(emails[i+1].Date),
			"emails should be sorted newest first")
	}
}
