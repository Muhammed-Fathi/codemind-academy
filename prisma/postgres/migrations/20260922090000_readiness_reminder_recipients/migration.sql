-- ===========================================================================
-- Teacher Readiness — recipient choice for the readiness reminder (PostgreSQL
-- edition).
--
-- This is the PostgreSQL twin of the SQLite migration of the same name. The
-- two files are NOT copies: SQLite stores enums as TEXT and needs no DDL for
-- a new notification type, while PostgreSQL grows the native enum with one
-- appended label. A type that already exists on production can only grow, so
-- the new label lands last and no existing label moves.
--
-- ADDITIVE ONLY. No table is created or rebuilt, no column is added or
-- dropped, no row is deleted. One enum label is appended, nothing else.
-- ===========================================================================

ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'READINESS_REMINDER';
