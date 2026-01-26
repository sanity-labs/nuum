-- Background reports table
-- Allows background workers (LTM curator, distillation, etc.) to file reports
-- that get surfaced to the main agent at the start of the next turn.

CREATE TABLE IF NOT EXISTS background_reports (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  subsystem TEXT NOT NULL,  -- e.g., 'ltm_curator', 'distillation'
  report TEXT NOT NULL,     -- JSON report content
  surfaced_at TEXT          -- NULL until shown to main agent
);

-- Index for efficient lookup of unsurfaced reports
CREATE INDEX IF NOT EXISTS idx_background_reports_unsurfaced 
  ON background_reports(surfaced_at) WHERE surfaced_at IS NULL;
