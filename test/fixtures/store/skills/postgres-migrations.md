---
name: postgres-migrations
description: Write safe, reversible PostgreSQL schema migrations and run them in CI.
---

# Postgres migrations

Every migration has an `up` and a `down`. Never rename a column in one step: add, backfill, then drop.
