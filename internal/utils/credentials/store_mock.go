package credentials

import (
	"github.com/zalando/go-keyring"
)

type mockProvider struct {
	mockStore map[string]map[string]string
	mockError error
}

// Get retrieves the password for a project from the mock store.
func (m *mockProvider) Get(project string) (string, error) {
	if m.mockError != nil {
		return "", m.mockError
	}
	if pass, ok := m.mockStore[namespace][project]; ok {
		return pass, nil
	}
	return "", keyring.ErrNotFound
}

// Set stores the password for a project in the mock store.
func (m *mockProvider) Set(project, password string) error {
	if m.mockError != nil {
		return m.mockError
	}
	if m.mockStore == nil {
		m.mockStore = make(map[string]map[string]string)
	}
	if m.mockStore[namespace] == nil {
		m.mockStore[namespace] = make(map[string]string)
	}
	m.mockStore[namespace][project] = password
	return nil
}

// Delete removes the password for a project from the mock store.
func (m *mockProvider) Delete(project string) error {
	if m.mockError != nil {
		return m.mockError
	}
	if _, ok := m.mockStore[namespace][project]; ok {
		delete(m.mockStore[namespace], project)
		return nil
	}
	return keyring.ErrNotFound
}

// DeleteAll removes all passwords from the mock store.
func (m *mockProvider) DeleteAll() error {
	if m.mockError != nil {
		return m.mockError
	}
	delete(m.mockStore, namespace)
	return nil
}

func MockInit() func() {
	oldStore := StoreProvider
	teardown := func() {
		StoreProvider = oldStore
	}
	StoreProvider = &mockProvider{
		mockStore: map[string]map[string]string{},
	}
	return teardown
}
