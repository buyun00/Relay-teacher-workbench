CREATE TABLE IF NOT EXISTS qb_batches (
 id TEXT PRIMARY KEY, title TEXT NOT NULL, source_asset_id TEXT NOT NULL REFERENCES assets(id),
 created_at TEXT NOT NULL, item_count INTEGER NOT NULL, metadata TEXT NOT NULL,
 UNIQUE(source_asset_id)
);
CREATE TABLE IF NOT EXISTS qb_items (
 id TEXT PRIMARY KEY, revision INTEGER NOT NULL DEFAULT 1,
 parent_id TEXT REFERENCES qb_items(id), parent_revision INTEGER,
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
 CHECK ((parent_id IS NULL) = (parent_revision IS NULL))
);
CREATE TABLE IF NOT EXISTS qb_revisions (
 item_id TEXT NOT NULL REFERENCES qb_items(id), revision INTEGER NOT NULL,
 body TEXT NOT NULL, reason TEXT NOT NULL, created_at TEXT NOT NULL,
 PRIMARY KEY(item_id,revision)
);
CREATE TABLE IF NOT EXISTS qb_batch_items (
 batch_id TEXT NOT NULL REFERENCES qb_batches(id), position INTEGER NOT NULL,
 item_id TEXT NOT NULL REFERENCES qb_items(id), source_ref TEXT NOT NULL,
 PRIMARY KEY(batch_id,position), UNIQUE(batch_id,item_id)
);
CREATE TABLE IF NOT EXISTS qb_papers (
 id TEXT PRIMARY KEY, title TEXT NOT NULL, student_id TEXT REFERENCES students(id),
 purpose TEXT NOT NULL, evidence TEXT NOT NULL, artifact_id TEXT NOT NULL REFERENCES artifacts(id),
 created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS qb_paper_items (
 paper_id TEXT NOT NULL REFERENCES qb_papers(id), position INTEGER NOT NULL,
 item_id TEXT NOT NULL, revision INTEGER NOT NULL, task TEXT NOT NULL,
 PRIMARY KEY(paper_id,position),
 FOREIGN KEY(item_id,revision) REFERENCES qb_revisions(item_id,revision)
);
CREATE TABLE IF NOT EXISTS qb_attempts (
 id TEXT PRIMARY KEY, paper_id TEXT NOT NULL, position INTEGER NOT NULL,
 response TEXT NOT NULL, assistance TEXT NOT NULL, assessment TEXT NOT NULL,
 created_at TEXT NOT NULL,
 FOREIGN KEY(paper_id,position) REFERENCES qb_paper_items(paper_id,position)
);
CREATE INDEX IF NOT EXISTS qb_item_parent ON qb_items(parent_id);
CREATE INDEX IF NOT EXISTS qb_paper_student ON qb_papers(student_id);
