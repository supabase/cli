-- Query to fetch replication settings and metrics
SELECT
    current_setting('wal_keep_size') as wal_keep_size,
    current_setting('max_wal_size') as max_wal_size,
    current_setting('min_wal_size') as min_wal_size,
    current_setting('max_slot_wal_keep_size') as max_slot_wal_keep_size,
    current_setting('wal_sender_timeout') as wal_sender_timeout,
    current_setting('max_standby_streaming_delay') as max_standby_streaming_delay,
    current_setting('checkpoint_timeout') as checkpoint_timeout,
    pg_current_wal_lsn() as current_wal_lsn;
