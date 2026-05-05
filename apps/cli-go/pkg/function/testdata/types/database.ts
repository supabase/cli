export type Database = {
  public: {
    Tables: {
      users: {
        Row: { id: string; name: string }
      }
    }
  }
}

export type Json = string | number | boolean | null | { [key: string]: Json } | Json[]
