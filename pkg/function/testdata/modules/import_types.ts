// Test file for multiline import type statements
// This pattern was broken before the [\s\S]*? fix

// Multiline import type - should be matched by the regex
import type {
  Database,
  Json
} from '../types/database.ts'

// Single line import type - should also work
import type { Database as DB } from '../types/database.ts'

// Re-export type to verify export pattern
export type { Database } from '../types/database.ts'

// Multiline export type
export type {
  Json
} from '../types/database.ts'
