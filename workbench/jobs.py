from __future__ import annotations

import json
import time

from .artifacts import Artifacts
from .config import WorkbenchError
from .facts import Facts, stable_id
from .storage import Store, encode, identifier, now


class Jobs:
    def __init__(self, store: Store):
        self.store = store

    def enqueue(self, kind: str, input_version: str, asset_id=None, lesson_id=None) -> dict:
        if kind not in {"audio", "review", "courseware"}:
            raise WorkbenchError("任务类型无效")
        with self.store.transaction() as db:
            if asset_id:
                self.store.one("assets", asset_id, db)
            if lesson_id:
                self.store.one("lessons", lesson_id, db)
            old = db.execute("SELECT id FROM jobs WHERE kind=? AND asset_id IS ? AND lesson_id IS ? AND input_version=?", (kind, asset_id, lesson_id, input_version)).fetchone()
            jid = old[0] if old else identifier("job")
            if not old:
                db.execute("INSERT INTO jobs(id,asset_id,lesson_id,kind,input_version,updated_at) VALUES(?,?,?,?,?,?)", (jid, asset_id, lesson_id, kind, input_version, now()))
        return self.store.one("jobs", jid)

    def claim(self, job_id: str, owner: str, kind=None) -> dict:
        owner = stable_id(owner)
        with self.store.transaction() as db:
            row = self.store.one("jobs", job_id, db)
            if kind is not None and kind != row["kind"]:
                raise WorkbenchError("任务类型与指定 kind 不匹配")
            expired = row["state"] == "running" and (row["lease_until"] or 0) < time.time()
            if row["state"] not in {"queued", "ready"} and not expired:
                raise WorkbenchError("任务不能领取：已有执行者、已完成或需要人工处理")
            if row["attempts"] >= self.store.config.max_attempts:
                db.execute("UPDATE jobs SET state='failed',error=?,updated_at=? WHERE id=?", ("达到尝试上限", now(), job_id))
                return self.store.one("jobs", job_id, db)
            db.execute("UPDATE jobs SET state='running',attempts=attempts+1,owner=?,fence=fence+1,lease_until=?,updated_at=? WHERE id=?", (owner, time.time() + self.store.config.lease_seconds, now(), job_id))
            return self.store.one("jobs", job_id, db)

    @staticmethod
    def check_owner(row, owner, fence):
        if row["state"] != "running" or row["owner"] != owner or row["fence"] != fence or (row["lease_until"] or 0) < time.time():
            raise WorkbenchError("任务租约失效，旧执行者不能继续提交")

    def heartbeat(self, job_id: str, owner: str, fence: int) -> dict:
        with self.store.transaction() as db:
            row = self.store.one("jobs", job_id, db)
            self.check_owner(row, owner, fence)
            db.execute("UPDATE jobs SET lease_until=?,updated_at=? WHERE id=?", (time.time() + self.store.config.lease_seconds, now(), job_id))
        return self.store.one("jobs", job_id)

    def complete(self, job_id: str, owner: str, fence: int, artifact_id: str) -> dict:
        artifact = Artifacts(self.store).read(artifact_id)
        if artifact["stale"]:
            raise WorkbenchError("产物已过期，不能完成任务")
        with self.store.transaction() as db:
            row = self.store.one("jobs", job_id, db)
            if row["state"] == "completed" and json.loads(row["result"])["artifact_id"] == artifact_id:
                return row
            self.check_owner(row, owner, fence)
            expected_kind = "courseware" if row["kind"] == "courseware" else "brief"
            if artifact["kind"] != expected_kind:
                raise WorkbenchError("产物类型与任务不匹配，不能用文字草稿完成课件任务")
            source_ids = {r["id"] for r in artifact["sources"]}
            if row["lesson_id"] and row["lesson_id"] not in source_ids:
                raise WorkbenchError("产物必须包含任务课次的当前版本依赖")
            if row["lesson_id"]:
                lesson = self.store.one("lessons", row["lesson_id"], db)
                if row["kind"] == "review" and row["input_version"] != str(lesson["revision"]):
                    raise WorkbenchError("课次已更正，旧输入任务不能提交完成")
            if row["kind"] == "audio" and (not row["external_id"] or not row["result"] or not json.loads(row["result"]).get("transcript_id")):
                raise WorkbenchError("转写尚未持久化，不能完成录音复盘任务")
            if row["kind"] == "audio":
                cited_assets = {r["id"] for r in artifact["sources"] if r["kind"] == "asset"}
                for ref in artifact["sources"]:
                    if ref["kind"] == "segment":
                        seg = self.store.one("segments", ref["id"], db)
                        cited_assets.add(self.store.one("transcripts", seg["transcript_id"], db)["asset_id"])
                    elif ref["kind"] == "event":
                        event = self.store.one("events", ref["id"], db)
                        for source in json.loads(event["sources"]):
                            if source["kind"] == "segment":
                                seg = self.store.one("segments", source["id"], db)
                                cited_assets.add(self.store.one("transcripts", seg["transcript_id"], db)["asset_id"])
                if row["asset_id"] not in cited_assets:
                    raise WorkbenchError("复盘产物未引用任务对应录音的转写或原件")
            Facts(self.store).sources(artifact["sources"], db)
            result = json.loads(row["result"]) if row["result"] else {}
            result["artifact_id"] = artifact_id
            db.execute("UPDATE jobs SET state='completed',result=?,lease_until=NULL,updated_at=? WHERE id=?", (encode(result), now(), job_id))
            self.store.audit(db, "job_complete", job_id, {"artifact_id": artifact_id})
        return self.store.one("jobs", job_id)

    def recover(self) -> dict:
        with self.store.transaction() as db:
            expired = [dict(r) for r in db.execute("SELECT * FROM jobs WHERE state='running' AND lease_until<?", (time.time(),))]
            for row in expired:
                if row["kind"] in {"audio", "courseware"}:
                    # No idempotency API on the reused external engines: an interrupted submit
                    # may have succeeded. Never guess and pay for/re-run it automatically.
                    state, reason = "needs_attention", "执行中断；请核查外部任务，避免重复提交"
                elif row["attempts"] >= self.store.config.max_attempts:
                    state, reason = "failed", "达到尝试上限"
                else:
                    state, reason = "queued", "执行租约过期，等待重新领取"
                db.execute("UPDATE jobs SET state=?,owner=NULL,lease_until=NULL,error=?,updated_at=? WHERE id=?", (state, reason, now(), row["id"]))
        return {"recovered": len(expired)}

    def list(self, state=None, kind=None) -> dict:
        with self.store.connect() as db:
            rows = [dict(r) for r in db.execute("SELECT * FROM jobs WHERE (? IS NULL OR state=?) AND (? IS NULL OR kind=?) ORDER BY updated_at,id", (state, state, kind, kind))]
        return {"jobs": rows}

    def retry(self, job_id: str, external_checked: bool, reason: str) -> dict:
        """Operator-only reconciliation, never a model tool or an automatic retry."""
        from .facts import required_text
        reason = required_text(reason, "核查说明", 2000)
        if not external_checked:
            raise WorkbenchError("须先核查外部执行已停止、结果未提交")
        with self.store.transaction() as db:
            row = self.store.one("jobs", job_id, db)
            if row["state"] not in {"needs_attention", "failed"} or row["attempts"] >= self.store.config.max_attempts:
                raise WorkbenchError("状态不支持重试或达到尝试上限")
            if row["kind"] == "audio":
                raise WorkbenchError("录音提交有重复风险；先核对 ASR 外部任务 ID，不使用通用重试")
            db.execute("UPDATE jobs SET state='queued',owner=NULL,lease_until=NULL,error=NULL,external_id=NULL,updated_at=? WHERE id=?", (now(),job_id))
            self.store.audit(db,"operator_retry",job_id,{"reason":reason,"previous_fence":row["fence"]})
        return self.store.one("jobs",job_id)
