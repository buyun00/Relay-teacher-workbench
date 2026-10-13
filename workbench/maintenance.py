"""Explicit operator export/deletion. Never exposed as a model tool."""
from __future__ import annotations

import hashlib
import json
import shutil
import time
from pathlib import Path

from .config import WorkbenchError
from .storage import ClosingConnection, Store, atomic_write, encode, identifier


class Maintenance:
    def __init__(self, store: Store):
        self.store = store

    def export(self):
        backup = self.store.backup()
        folder = Path(backup["path"])
        import sqlite3
        with sqlite3.connect(folder / "workbench.sqlite",factory=ClosingConnection) as db:
            db.row_factory = sqlite3.Row
            tables = [r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type='table' AND name!='sqlite_sequence'")]
            data = {name: [dict(r) for r in db.execute(f'SELECT * FROM "{name}"')] for name in tables}
        atomic_write(folder / "records.json", encode(data).encode())
        return {**backup, "records": str(folder / "records.json"), "external_copies": self.external_copies()}

    @staticmethod
    def external_copies():
        return ["Hermes 会话记录与模型供应商副本", "已有 ASR 服务自己的任务文件", "手工复制、下载或存到其他位置的备份"]

    def _plan(self, db, lesson_ids, exam_ids):
        lessons, exams = set(lesson_ids), set(exam_ids)
        if not lessons and not exams:
            raise WorkbenchError("必须明确指定课次或测验范围")
        for lid in lessons: self.store.one("lessons", lid, db)
        for eid in exams: self.store.one("exams", eid, db)
        events = {r["id"] for r in db.execute("SELECT id,lesson_id FROM events") if r["lesson_id"] in lessons}
        scores = {r["id"] for r in db.execute("SELECT id,exam_id FROM scores") if r["exam_id"] in exams}
        possible = {r["asset_id"] for r in db.execute("SELECT * FROM lesson_assets") if r["lesson_id"] in lessons}
        possible |= {self.store.one("exams", eid, db)["source_asset_id"] for eid in exams}
        retained = {r["asset_id"] for r in db.execute("SELECT * FROM lesson_assets") if r["lesson_id"] not in lessons}
        retained |= {r["source_asset_id"] for r in db.execute("SELECT * FROM exams") if r["id"] not in exams}
        activities = {r["id"] for r in db.execute("SELECT id,lesson_id FROM recording_activities") if r["lesson_id"] in lessons}
        retained |= {r["asset_id"] for r in db.execute("SELECT activity_id,asset_id FROM recording_activity_assets") if r["activity_id"] not in activities}
        assets = possible - retained
        transcripts = {r["id"] for r in db.execute("SELECT * FROM transcripts") if r["asset_id"] in assets}
        segments = {r["id"] for r in db.execute("SELECT id,transcript_id FROM segments") if r["transcript_id"] in transcripts}
        targets = {("lesson", x) for x in lessons} | {("exam", x) for x in exams} | {("asset", x) for x in assets} | {("segment", x) for x in segments} | {("event", x) for x in events} | {("score", x) for x in scores}
        artifacts = {r["id"] for r in db.execute("SELECT * FROM artifacts") if any((s["kind"], s["id"]) in targets for s in json.loads(r["sources"]))}
        artifact_rows = [dict(r) for r in db.execute("SELECT * FROM artifacts")]
        kept_paths = {r["path"] for r in artifact_rows if r["id"] not in artifacts}
        deleted_courseware_paths = {r["path"] for r in artifact_rows if r["id"] in artifacts and r["kind"]=="courseware" and r["path"] not in kept_paths}
        assets |= {r["id"] for r in db.execute("SELECT * FROM assets") if r["path"] in deleted_courseware_paths and r["id"] not in retained}
        jobs = set()
        for row in db.execute("SELECT * FROM jobs"):
            if row["lesson_id"] in lessons or row["asset_id"] in assets or (row["result"] and json.loads(row["result"]).get("artifact_id") in artifacts) or any(aid in row["input_version"] for aid in artifacts):
                if row["state"] == "running":
                    raise WorkbenchError("范围内有执行中的任务，请等其结束后重新生成删除计划")
                jobs.add(row["id"])
        removed_workflows, affected_workflows = set(), set()
        for row in db.execute("SELECT * FROM recording_workflows"):
            if row["asset_id"] in assets or row["audio_job_id"] in jobs or row["review_id"] in artifacts or row["preparation_id"] in artifacts:
                if (row["lease_until"] or 0) > time.time():
                    raise WorkbenchError("范围内有执行中的录音流程，请等其结束后重新生成删除计划")
                (removed_workflows if row["asset_id"] in assets else affected_workflows).add(row["id"])
        paths = {self.store.one("assets", aid, db)["path"] for aid in assets}
        paths |= {self.store.one("transcripts", tid, db)["path"].rsplit("/", 1)[0] for tid in transcripts}
        paths |= {self.store.one("artifacts", aid, db)["path"] for aid in artifacts if self.store.one("artifacts", aid, db)["path"] not in kept_paths}
        for jid in jobs:
            paths.add("drafts/" + jid)
        for workflow_id in removed_workflows | affected_workflows:
            paths.add("drafts/" + workflow_id)
        # Known local backups may contain the deleted scope. Purge them all, clearly in the plan.
        paths |= {str(p.relative_to(self.store.root)) for p in (self.store.root / "backups").iterdir()}
        result = {"lessons": sorted(lessons), "exams": sorted(exams), "events": sorted(events), "scores": sorted(scores),
                  "recording_activities": sorted(activities),
                  "assets": sorted(assets), "transcripts": sorted(transcripts), "segments": sorted(segments),
                  "artifacts": sorted(artifacts), "jobs": sorted(jobs), "recording_workflows": sorted(removed_workflows),
                  "affected_recording_workflows": sorted(affected_workflows), "paths": sorted(paths), "external_copies": self.external_copies()}
        result["confirmation"] = hashlib.sha256(encode(result).encode()).hexdigest()
        return result

    def plan(self, lesson_ids=(), exam_ids=()):
        with self.store.connect() as db:
            return self._plan(db, lesson_ids, exam_ids)

    def delete(self, lesson_ids=(), exam_ids=(), confirmation=""):
        with self.store.transaction() as db:
            plan = self._plan(db, lesson_ids, exam_ids)
            if not confirmation or confirmation != plan["confirmation"]:
                raise WorkbenchError("删除计划未确认或范围变化，请重新预览并传入完整 confirmation")
            # Validate every physical path before any database/file mutation.
            paths = [self.store.config.stored_file(p) for p in plan["paths"]]
            for p in paths:
                if p == self.store.root.resolve() or p.is_symlink():
                    raise WorkbenchError("不能删除数据根或链接目录")
            db.execute("PRAGMA secure_delete=ON")
            def remove(table, ids, column="id"):
                if ids:
                    db.execute(f"DELETE FROM {table} WHERE {column} IN ({','.join('?' for _ in ids)})", ids)
            remove("deliveries", plan["jobs"], "job_id")
            remove("deliveries", plan["artifacts"], "artifact_id")
            remove("recording_workflows", plan["recording_workflows"])
            for workflow_id in plan["affected_recording_workflows"]:
                row = self.store.one("recording_workflows", workflow_id, db)
                db.execute("UPDATE recording_workflows SET state='needs_attention',owner=NULL,lease_until=NULL,"
                           "audio_job_id=?,review_id=?,preparation_id=?,error=? WHERE id=?",
                           (None if row['audio_job_id'] in plan['jobs'] else row['audio_job_id'],
                            None if row['review_id'] in plan['artifacts'] else row['review_id'],
                            None if row['preparation_id'] in plan['artifacts'] else row['preparation_id'],
                            '关联资料范围已删除，请核查；不会自动重新提交录音', workflow_id))
            if db.execute("SELECT 1 FROM sqlite_master WHERE name='desktop_uploads'").fetchone():
                for asset_id in plan["assets"]:
                    sha = self.store.one("assets", asset_id, db)["sha256"]
                    db.execute("DELETE FROM desktop_uploads WHERE sha256=?", (sha,))
            remove("jobs", plan["jobs"])
            remove("artifacts", plan["artifacts"])
            remove("questions", plan["lessons"], "lesson_id")
            for kind, ids in [("recording_activity",plan["recording_activities"]),("event", plan["events"]),("segment",plan["segments"]),("lesson",plan["lessons"]),("score",plan["scores"])]:
                if ids:
                    db.execute(f"DELETE FROM corrections WHERE target_kind=? AND target_id IN ({','.join('?' for _ in ids)})", (kind,*ids))
            remove("events", plan["events"])
            remove("scores", plan["exams"], "exam_id")
            remove("exam_questions", plan["exams"], "exam_id")
            remove("exams", plan["exams"])
            remove("lesson_assets", plan["lessons"], "lesson_id")
            remove("lessons", plan["lessons"])
            remove("segments", plan["segments"])
            remove("transcripts", plan["transcripts"])
            remove("assets", plan["assets"])
            # Durable purge queue survives a crash after the database commit.
            pid = identifier("purge")
            db.execute("INSERT INTO metadata(key,value) VALUES(?,?)", (pid, encode(plan["paths"])))
            self.store.audit(db, "delete_scope", pid, {"lessons": plan["lessons"], "exams": plan["exams"]})
        self.purge()
        return {"deleted": plan, "external_copies_require_separate_handling": self.external_copies()}

    def purge(self):
        with self.store.connect() as db:
            queued = [dict(r) for r in db.execute("SELECT * FROM metadata WHERE key LIKE 'purge_%'")]
        for item in queued:
            for relative in json.loads(item["value"]):
                path = self.store.config.stored_file(relative)
                if path == self.store.root.resolve(): raise WorkbenchError("不能删除数据根")
                if path.is_dir(): shutil.rmtree(path)
                else: path.unlink(missing_ok=True)
            with self.store.transaction() as db:
                db.execute("DELETE FROM metadata WHERE key=?", (item["key"],))
        with self.store.connect() as db:
            db.execute("PRAGMA wal_checkpoint(TRUNCATE)")
            db.execute("VACUUM")
        return {"purged": len(queued)}
