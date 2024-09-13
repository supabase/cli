package credentials

import (
	"github.com/zalando/go-keyring"
)

type MockProvider struct {
	MockStore map[string]map[string]string
	MockError error
}

// Get retrieves the password for a project from the mock store.
func (m *MockProvider) Get(project string) (string, error) {
	if m.MockError != nil {
		return "", m.MockError
	}
	if pass, ok := m.MockStore[namespace][project]; ok {
		return pass, nil
	}
	return "", keyring.ErrNotFound
}

// Set stores the password for a project in the mock store.
func (m *MockProvider) Set(project, password string) error {
	if m.MockError != nil {
		return m.MockError
	}
	if m.MockStore == nil {
		m.MockStore = make(map[string]map[string]string)
	}
	if m.MockStore[namespace] == nil {
		m.MockStore[namespace] = make(map[string]string)
	}
	m.MockStore[namespace][project] = password
	return nil
}

// Delete removes the password for a project from the mock store.
func (m *MockProvider) Delete(project string) error {
	if m.MockError != nil {
		return m.MockError
	}
	if _, ok := m.MockStore[namespace][project]; ok {
		delete(m.MockStore[namespace], project)
		return nil
	}
	return keyring.ErrNotFound
}

// DeleteAll removes all passwords from the mock store.
func (m *MockProvider) DeleteAll() error {
	if m.MockError != nil {
		return m.MockError
	}
	delete(m.MockStore, namespace)
	return nil
}

func MockInit(mockProvider Store) func() {
	oldStore := StoreProvider
	teardown := func() {
		StoreProvider = oldStore
	}
	StoreProvider = mockProvider
	return teardown
}
