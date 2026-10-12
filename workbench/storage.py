from __future__ import annotations

import hashlib
import json
import os
import shutil
import sqlite3
import uuid
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path

from .config import Config, WorkbenchError


def now() -> str:
    return datetime.now(timezone.utc).isoformat()


def identifier(prefix: str) -> str:
    return prefix + "_" + uuid.uuid4().hex[:16]


def encode(value) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, allow_nan=False)


def atomic_write(path: Path, data: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.parent / (".tmp-" + uuid.uuid4().hex)
    with temporary.open("xb") as out:
        try:
            out.write(data)
            out.flush()
            os.fsync(out.fileno())
        except BaseException:
            temporary.unlink(missing_ok=True)
            raise
    try:
        os.replace(temporary, path)
        # Persist the rename where the host supports directory fsync.
        if os.name != "nt":
            fd = os.open(path.parent, os.O_RDONLY)
            try:
                os.fsync(fd)
            finally:
                os.close(fd)
    finally:
        temporary.unlink(missing_ok=True)


class Store:
    def __init__(self, config: Config):
        self.config = config
        self.root = config.root
        for d in ("database", "originals", "transcripts", "artifacts", "inbox", "drafts", "temporary", "backups"):
            (self.root / d).mkdir(parents=True, exist_ok=True)
        self.db_path = self.root / "database" / "workbench.sqlite"
        with self.connect() as db:
            version = db.execute("PRAGMA user_version").fetchone()[0]
            if version > 1:
                raise WorkbenchError("数据库版本比此插件新，拒绝降级写入")
            db.executescript(Path(__file__).with_name("schema.sql").read_text(encoding="utf-8"))
            db.execute("INSERT OR IGNORE INTO metadata VALUES('workspace_id',?)", (config.workspace_id,))
            if db.execute("SELECT value FROM metadata WHERE key='workspace_id'").fetchone()[0] != config.workspace_id:
                raise WorkbenchError("资料库与当前教师空间不匹配")
            db.execute("PRAGMA user_version=1")

    def connect(self):
        db = sqlite3.connect(self.db_path, timeout=15, factory=ClosingConnection)
        db.row_factory = sqlite3.Row
        db.execute("PRAGMA foreign_keys=ON")
        db.execute("PRAGMA journal_mode=WAL")
        db.execute("PRAGMA synchronous=FULL")
        return db

    @contextmanager
    def transaction(self):
        db = self.connect()
        try:
            db.execute("BEGIN IMMEDIATE")
            yield db
            db.commit()
        except BaseException:
            db.rollback()
            raise
        finally:
            db.close()

    def one(self, table: str, value: str, db=None):
        allowed = {"classes", "students", "lessons", "assets", "transcripts", "segments", "messages", "events", "questions", "exams", "scores", "artifacts", "jobs", "recording_workflows"}
        if table not in allowed:
            raise WorkbenchError("不支持此类资料")
        if db is not None:
            row = db.execute(f"SELECT * FROM {table} WHERE id=?", (value,)).fetchone()
        else:
            with self.connect() as conn:
                row = conn.execute(f"SELECT * FROM {table} WHERE id=?", (value,)).fetchone()
        if row is None:
            raise WorkbenchError(f"资料不存在：{table}/{value}")
        return dict(row)

    @staticmethod
    def audit(db, operation: str, target_id: str | None, detail: dict):
        db.execute("INSERT INTO audit(at,operation,target_id,detail) VALUES(?,?,?,?)", (now(), operation, target_id, encode(detail)))

    def ingest(self, path: str, kind: str, provenance: dict | None = None, task: dict | None = None) -> dict:
        source = self.config.input_file(path)
        if kind not in {"audio", "transcript", "roster", "scores", "document", "courseware"}:
            raise WorkbenchError("不支持此资料类型")
        digest = hashlib.sha256()
        size = 0
        temporary = self.root / "temporary" / (".import-" + uuid.uuid4().hex)
        with temporary.open("xb") as out:
            try:
                with source.open("rb") as stream:
                    while chunk := stream.read(1024 * 1024):
                        size += len(chunk)
                        digest.update(chunk)
                        out.write(chunk)
                out.flush()
                os.fsync(out.fileno())
            except BaseException:
                temporary.unlink(missing_ok=True)
                raise
        try:
            sha = digest.hexdigest()
            # Content-addressed paths let a later retry recover a rename-before-DB crash.
            relative = "originals/" + sha + "/original" + source.suffix.lower()
            target = self.config.stored_file(relative)
            with self.transaction() as db:
                row = db.execute("SELECT * FROM assets WHERE sha256=?", (sha,)).fetchone()
                if row is not None:
                    job = self._import_task(db, row["id"], task) if task else None
                    return {**dict(row), "duplicate": True, "job": job}
                target.parent.mkdir(parents=True, exist_ok=True)
                os.replace(temporary, target)
                if os.name != "nt":
                    fd = os.open(target.parent, os.O_RDONLY)
                    try:
                        os.fsync(fd)
                    finally:
                        os.close(fd)
                asset_id = "asset_" + sha[:24]
                db.execute("INSERT INTO assets VALUES(?,?,?,?,?,?,?,?)", (asset_id, kind, sha, size, source.name, relative, now(), encode(provenance or {})))
                self.audit(db, "import", asset_id, {"kind": kind, "bytes": size})
                job = self._import_task(db, asset_id, task) if task else None
            return {**self.one("assets", asset_id), "duplicate": False, "job": job}
        finally:
            temporary.unlink(missing_ok=True)

    def _import_task(self, db, asset_id, task):
        lesson = self.one("lessons", task["lesson_id"], db)
        db.execute("INSERT OR IGNORE INTO lesson_assets(lesson_id,asset_id) VALUES(?,?)", (lesson["id"], asset_id))
        old = db.execute("SELECT id FROM jobs WHERE kind=? AND asset_id=? AND lesson_id=? AND input_version=?", (task["kind"], asset_id, lesson["id"], task["input_version"])).fetchone()
        job_id = old[0] if old else identifier("job")
        if not old:
            db.execute("INSERT INTO jobs(id,asset_id,lesson_id,kind,input_version,updated_at) VALUES(?,?,?,?,?,?)", (job_id, asset_id, lesson["id"], task["kind"], task["input_version"], now()))
        return self.one("jobs", job_id, db)

    def backup(self) -> dict:
        target = self.root / "backups" / identifier("backup")
        target.mkdir()
        # Writers use BEGIN IMMEDIATE; hold that lock while snapshotting DB + immutable files.
        with self.transaction() as locked:
            with self.connect() as reader, sqlite3.connect(target / "workbench.sqlite", factory=ClosingConnection) as out:
                reader.backup(out)
            for directory in ("originals", "transcripts", "artifacts"):
                shutil.copytree(self.root / directory, target / directory)
            manifest = {"workspace_id": self.config.workspace_id, "created_at": now(), "schema_version": 1}
            atomic_write(target / "manifest.json", encode(manifest).encode())
            settings = {"workspace_id":self.config.workspace_id,"data_root":str(self.config.root),
                "speech_url":self.config.speech_url,"speech_client":str(self.config.speech_client) if self.config.speech_client else None,
                "hermes_command":str(self.config.hermes_command) if self.config.hermes_command else None,"courseware_profile":self.config.courseware_profile,
                "lease_seconds":self.config.lease_seconds,"max_attempts":self.config.max_attempts}
            atomic_write(target / "teacher-workbench.config.json", encode(settings).encode())
            self.audit(locked, "backup", target.name, {})
        return {"backup_id": target.name, "path": str(target), "includes": ["database", "originals", "transcripts", "artifacts"]}

    @staticmethod
    def restore(backup: Path, destination: Path) -> dict:
        """Restore into a NEW directory; never overwrite a live workspace."""
        backup, destination = backup.resolve(strict=True), destination.resolve()
        if destination.exists():
            raise WorkbenchError("恢复目标必须是尚不存在的新目录")
        manifest = json.loads((backup / "manifest.json").read_text(encoding="utf-8"))
        if manifest.get("schema_version") != 1:
            raise WorkbenchError("备份版本不支持")
        with sqlite3.connect(backup / "workbench.sqlite", factory=ClosingConnection) as db:
            if db.execute("PRAGMA integrity_check").fetchone()[0] != "ok" or db.execute("PRAGMA foreign_key_check").fetchone():
                raise WorkbenchError("备份数据库完整性检查失败")
        destination.mkdir(parents=True)
        (destination / "database").mkdir()
        shutil.copy2(backup / "workbench.sqlite", destination / "database" / "workbench.sqlite")
        for directory in ("originals", "transcripts", "artifacts"):
            shutil.copytree(backup / directory, destination / directory)
        if (backup / "teacher-workbench.config.json").is_file():
            settings=json.loads((backup / "teacher-workbench.config.json").read_text(encoding="utf-8"))
            settings.update(data_root=str(destination))
            for key in ("import_roots", "courseware_uid", "max_file_bytes"):
                settings.pop(key, None)
            atomic_write(destination / "teacher-workbench.config.json",encode(settings).encode())
        restored = Store(Config(root=destination, workspace_id=manifest["workspace_id"]))
        # External processes are not part of a file backup. Require reconciliation.
        with restored.transaction() as db:
            db.execute("UPDATE jobs SET state='needs_attention',owner=NULL,lease_until=NULL,error='从备份恢复，请核查外部执行状态' WHERE state IN ('running','waiting_external')")
            db.execute("UPDATE recording_workflows SET state='needs_attention',owner=NULL,lease_until=NULL,"
                       "error='从备份恢复，请核查外部执行状态；不会自动重新提交录音' WHERE state!='completed'")
            db.execute("UPDATE desktop_turns SET state='interrupted',error='从业务备份恢复，请确认原生对话与外部执行状态；未重新执行消息' "
                       "WHERE state IN ('queued','running','cancelling')")
        return {"path": str(destination), "workspace_id": manifest["workspace_id"]}


class ClosingConnection(sqlite3.Connection):
    def __exit__(self, *args):
        try:
            return super().__exit__(*args)
        finally:
            self.close()
