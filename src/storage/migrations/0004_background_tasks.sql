-- Background Tasks: conscious async tasks (research, reflect) and alarms
-- These are tasks the agent explicitly started and expects results from.

-- Background tasks table
CREATE TABLE IF NOT EXISTS background_tasks (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,           -- 'research' | 'reflect'
  description TEXT NOT NULL,    -- Human-readable description
  status TEXT NOT NULL,         -- 'running' | 'completed' | 'failed' | 'killed'
  created_at TEXT NOT NULL,
  completed_at TEXT,
  result TEXT,                  -- JSON blob with task result
  error TEXT                    -- Error message if failed
);

CREATE INDEX IF NOT EXISTS idx_background_tasks_status ON background_tasks(status);

-- Queue for completed task results waiting to be delivered
CREATE TABLE IF NOT EXISTS background_task_queue (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  content TEXT NOT NULL         -- The message to inject
);

CREATE INDEX IF NOT EXISTS idx_background_task_queue_created ON background_task_queue(created_at);

-- Alarms: scheduled "notes to self" that trigger turns
CREATE TABLE IF NOT EXISTS alarms (
  id TEXT PRIMARY KEY,
  fires_at TEXT NOT NULL,       -- ISO timestamp
  note TEXT NOT NULL,           -- The "note to self"
  fired INTEGER NOT NULL DEFAULT 0  -- 1 if already fired
);

CREATE INDEX IF NOT EXISTS idx_alarms_fires_at ON alarms(fires_at);
