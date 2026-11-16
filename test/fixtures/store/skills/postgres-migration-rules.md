---
name: postgres-migration-rules
description: House rules for writing Postgres schema migrations in our services. Use when adding or changing tables, columns, indexes or constraints, or backfilling data.
---

# Postgres migration rules

Migrations are plain SQL in `migrations/`: `NNN_name.sql` with a matching `NNN_name.down.sql`. Our deploy pipeline runs them in order, each in its own transaction unless the file says otherwise.

## Every migration

1. Start every up migration with `SET lock_timeout = '2s';`. Deploys retry on timeout; a long lock wait takes the API down.
2. End every up migration with the line `-- owner: platform-team`. The deploy pipeline refuses migrations without an owner line.

## Backfills

3. Never backfill in the same migration that changes the schema. Add the column in one migration, and backfill in the next one, named `NNN_backfill_<what>.sql`.
4. Backfill in batches of 5000 rows with a `DO $$ ... $$` loop, committing nothing else in that file:

```sql
DO $$
DECLARE n integer;
BEGIN
  LOOP
    UPDATE users SET email = a.email
    FROM accounts a
    WHERE a.id = users.account_id AND users.id IN (
      SELECT id FROM users WHERE email IS NULL AND account_id IS NOT NULL LIMIT 5000
    );
    GET DIAGNOSTICS n = ROW_COUNT;
    EXIT WHEN n = 0;
  END LOOP;
END $$;
```

## Making a column NOT NULL

5. Never `ALTER COLUMN ... SET NOT NULL` directly on an existing table. Instead:
   - migration 1: `ALTER TABLE t ADD CONSTRAINT t_col_not_null CHECK (col IS NOT NULL) NOT VALID;`
   - migration 2: `ALTER TABLE t VALIDATE CONSTRAINT t_col_not_null;`

## Indexes

6. Create indexes with `CREATE INDEX CONCURRENTLY IF NOT EXISTS`. A concurrent index can't run inside a transaction, so the file's first line must be `-- migrate:no-transaction`, and the file must contain only the lock timeout, the index and the owner line.
