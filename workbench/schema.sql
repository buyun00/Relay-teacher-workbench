PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS classes (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, school_year TEXT
);
CREATE TABLE IF NOT EXISTS students (id TEXT PRIMARY KEY, name TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS memberships (
  class_id TEXT NOT NULL REFERENCES classes(id), student_id TEXT NOT NULL REFERENCES students(id),
  PRIMARY KEY(class_id, student_id)
);
CREATE TABLE IF NOT EXISTS lessons (
  id TEXT PRIMARY KEY, class_id TEXT REFERENCES classes(id), topic TEXT NOT NULL,
  occurred_at TEXT, revision INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS assets (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL, sha256 TEXT NOT NULL UNIQUE, byte_length INTEGER NOT NULL,
  filename TEXT NOT NULL, path TEXT NOT NULL, received_at TEXT NOT NULL, provenance TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS lesson_assets (
  lesson_id TEXT NOT NULL REFERENCES lessons(id), asset_id TEXT NOT NULL REFERENCES assets(id),
  start REAL NOT NULL DEFAULT 0, end REAL,
  PRIMARY KEY(lesson_id, asset_id, start)
);
CREATE TABLE IF NOT EXISTS transcripts (
  id TEXT PRIMARY KEY, asset_id TEXT NOT NULL REFERENCES assets(id), version TEXT NOT NULL,
  path TEXT NOT NULL, created_at TEXT NOT NULL,
  UNIQUE(asset_id, version)
);
CREATE TABLE IF NOT EXISTS segments (
  id TEXT PRIMARY KEY, transcript_id TEXT NOT NULL REFERENCES transcripts(id), position INTEGER NOT NULL,
  start REAL NOT NULL, end REAL NOT NULL, text TEXT NOT NULL, speaker TEXT,
  corrected_text TEXT, revision INTEGER NOT NULL DEFAULT 1,
  CHECK(start >= 0 AND end >= start), UNIQUE(transcript_id, position)
);
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL, platform TEXT NOT NULL, sender_id TEXT,
  external_ref TEXT, text TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY, lesson_id TEXT NOT NULL REFERENCES lessons(id), type TEXT NOT NULL,
  student_id TEXT REFERENCES students(id), identity_status TEXT NOT NULL,
  kind TEXT NOT NULL, review_status TEXT NOT NULL, content TEXT NOT NULL, sources TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL,
  CHECK(identity_status IN ('unknown','confirmed')),
  CHECK(kind IN ('observed','inference','teacher_observation')),
  CHECK(review_status IN ('unreviewed','confirmed','rejected')),
  CHECK((student_id IS NULL AND identity_status='unknown') OR
        (student_id IS NOT NULL AND identity_status='confirmed'))
);
CREATE TABLE IF NOT EXISTS questions (
  id TEXT PRIMARY KEY, event_id TEXT REFERENCES events(id), lesson_id TEXT REFERENCES lessons(id),
  text TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open', response TEXT, response_message_id TEXT REFERENCES messages(id),
  created_at TEXT NOT NULL, resolved_at TEXT, CHECK(status IN ('open','answered','skipped'))
);
CREATE TABLE IF NOT EXISTS corrections (
  id TEXT PRIMARY KEY, target_kind TEXT NOT NULL, target_id TEXT NOT NULL,
  before_json TEXT NOT NULL, after_json TEXT NOT NULL, message_id TEXT NOT NULL REFERENCES messages(id),
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS exams (
  id TEXT PRIMARY KEY, class_id TEXT NOT NULL REFERENCES classes(id), title TEXT NOT NULL,
  occurred_at TEXT, revision INTEGER NOT NULL DEFAULT 1, source_asset_id TEXT REFERENCES assets(id)
);
CREATE TABLE IF NOT EXISTS exam_questions (
  exam_id TEXT NOT NULL REFERENCES exams(id), id TEXT NOT NULL, max_points INTEGER NOT NULL,
  knowledge_point TEXT, mapping_status TEXT NOT NULL DEFAULT 'unknown',
  PRIMARY KEY(exam_id,id), CHECK(max_points > 0),
  CHECK(mapping_status IN ('unknown','proposed','confirmed'))
);
CREATE TABLE IF NOT EXISTS scores (
  id TEXT PRIMARY KEY, exam_id TEXT NOT NULL, question_id TEXT NOT NULL, student_id TEXT NOT NULL REFERENCES students(id),
  points INTEGER, status TEXT NOT NULL, cell TEXT NOT NULL, source_asset_id TEXT NOT NULL REFERENCES assets(id),
  revision INTEGER NOT NULL DEFAULT 1,
  FOREIGN KEY(exam_id,question_id) REFERENCES exam_questions(exam_id,id),
  UNIQUE(exam_id,question_id,student_id), CHECK(status IN ('scored','missing','absent','ungraded')),
  CHECK((status='scored' AND points IS NOT NULL AND points >= 0) OR (status!='scored' AND points IS NULL))
);
CREATE TABLE IF NOT EXISTS artifacts (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL, title TEXT NOT NULL, path TEXT NOT NULL,
  sources TEXT NOT NULL, stale INTEGER NOT NULL DEFAULT 0, revision INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL, validation TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY, asset_id TEXT REFERENCES assets(id), lesson_id TEXT REFERENCES lessons(id),
  kind TEXT NOT NULL, input_version TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'queued',
  attempts INTEGER NOT NULL DEFAULT 0, owner TEXT, fence INTEGER NOT NULL DEFAULT 0,
  lease_until REAL, external_id TEXT, result TEXT, error TEXT, updated_at TEXT NOT NULL,
  UNIQUE(kind,asset_id,lesson_id,input_version),
  CHECK(state IN ('queued','running','waiting_external','ready','completed','needs_attention','failed'))
);
CREATE TABLE IF NOT EXISTS deliveries (
  id TEXT PRIMARY KEY, job_id TEXT REFERENCES jobs(id), artifact_id TEXT NOT NULL REFERENCES artifacts(id),
  destination TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'pending', external_ref TEXT, error TEXT,
  CHECK(state IN ('pending','sent','unknown','failed'))
);
CREATE TABLE IF NOT EXISTS audit (
  id INTEGER PRIMARY KEY, at TEXT NOT NULL, operation TEXT NOT NULL, target_id TEXT, detail TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS events_lesson ON events(lesson_id);
CREATE INDEX IF NOT EXISTS events_student ON events(student_id);
CREATE INDEX IF NOT EXISTS jobs_state ON jobs(state,lease_until);
CREATE INDEX IF NOT EXISTS questions_status ON questions(status);
CREATE TABLE IF NOT EXISTS recording_workflows (
  id TEXT PRIMARY KEY, asset_id TEXT NOT NULL UNIQUE REFERENCES assets(id),
  audio_job_id TEXT REFERENCES jobs(id), state TEXT NOT NULL DEFAULT 'queued',
  owner TEXT, fence INTEGER NOT NULL DEFAULT 0, lease_until REAL,
  attempts INTEGER NOT NULL DEFAULT 0, error TEXT,
  review_id TEXT REFERENCES artifacts(id), preparation_id TEXT REFERENCES artifacts(id),
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  CHECK(state IN ('queued','transcribing','analyzing','completed','needs_attention'))
);
CREATE INDEX IF NOT EXISTS recording_workflow_state ON recording_workflows(state,lease_until);
CREATE TABLE IF NOT EXISTS desktop_chats(
  id TEXT PRIMARY KEY, hermes_session_id TEXT NOT NULL UNIQUE, native_tip TEXT NOT NULL,
  title TEXT NOT NULL, route_state TEXT NOT NULL DEFAULT 'triage', model_id TEXT,
  route_reason TEXT, category TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  CHECK(route_state IN ('triage','locked'))
);
CREATE TABLE IF NOT EXISTS desktop_turns(
  id TEXT PRIMARY KEY, chat_id TEXT NOT NULL REFERENCES desktop_chats(id),
  content TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'queued', answer TEXT NOT NULL DEFAULT '',
  model_id TEXT, error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  CHECK(state IN ('queued','running','cancelling','completed','cancelled','failed','interrupted'))
);
CREATE UNIQUE INDEX IF NOT EXISTS desktop_one_active_turn ON desktop_turns(chat_id)
  WHERE state IN ('queued','running','cancelling');
CREATE TABLE IF NOT EXISTS desktop_chat_events(
  seq INTEGER PRIMARY KEY AUTOINCREMENT, chat_id TEXT NOT NULL REFERENCES desktop_chats(id),
  turn_id TEXT, kind TEXT NOT NULL, payload TEXT NOT NULL, at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS desktop_chat_events_cursor ON desktop_chat_events(chat_id,seq);
CREATE TABLE IF NOT EXISTS desktop_chat_metadata(
  chat_id TEXT PRIMARY KEY REFERENCES desktop_chats(id), archived_at TEXT,
  title_source TEXT NOT NULL DEFAULT 'fallback', CHECK(title_source IN ('fallback','ai'))
);
CREATE TABLE IF NOT EXISTS desktop_chat_attachments(
  id TEXT PRIMARY KEY, chat_id TEXT NOT NULL REFERENCES desktop_chats(id),
  filename TEXT NOT NULL, mime TEXT NOT NULL, byte_length INTEGER NOT NULL,
  sha256 TEXT NOT NULL, offset INTEGER NOT NULL DEFAULT 0, received_at TEXT,
  CHECK(byte_length >= 0 AND offset >= 0 AND offset <= byte_length)
);
CREATE TABLE IF NOT EXISTS desktop_turn_attachments(
  turn_id TEXT NOT NULL REFERENCES desktop_turns(id),
  attachment_id TEXT NOT NULL REFERENCES desktop_chat_attachments(id), position INTEGER NOT NULL,
  PRIMARY KEY(turn_id,attachment_id), UNIQUE(turn_id,position)
);
