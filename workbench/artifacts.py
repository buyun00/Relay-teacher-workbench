from __future__ import annotations

import json

from .config import WorkbenchError
from .facts import Facts, required_text
from .storage import Store, atomic_write, encode, identifier, now


class Artifacts:
    def __init__(self, store: Store):
        self.store = store
        self.facts = Facts(store)

    def save(self, kind: str, title: str, sources: list, text=None, path=None, workflow=None) -> dict:
        if kind not in {"brief", "preparation", "exercise", "courseware", "student_summary"}:
            raise WorkbenchError("产物类型无效")
        title = required_text(title, "产物标题", 300)
        if kind == "courseware":
            validation = {"scope": "source_references_and_versions", "resource_structure_checked": False,
                          "teaching_quality_verified": False, "wps_playback_verified": False}
            asset = self.store.ingest(path, "courseware")
            relative = asset["path"]
        else:
            text = required_text(text, "产物正文", 200000)
            validation = {"scope": "source_references_and_versions", "teaching_quality_verified": False}
            relative = None
        aid = identifier("artifact")
        with self.store.transaction() as db:
            refs = self.facts.sources(sources, db)
            if not any(r["kind"] in {"segment", "event", "message", "score", "exam", "asset"} for r in refs):
                raise WorkbenchError("教学产物需要原文、教学事件、成绩或教师消息依据，不能只有课次标题")
            dependencies = []
            for ref in refs:
                if ref["kind"] == "event":
                    lesson_ids = [self.store.one("events", ref["id"], db)["lesson_id"]]
                elif ref["kind"] == "segment":
                    seg = self.store.one("segments", ref["id"], db)
                    transcript = self.store.one("transcripts", seg["transcript_id"], db)
                    lesson_ids = [r[0] for r in db.execute("SELECT lesson_id FROM lesson_assets WHERE asset_id=?", (transcript["asset_id"],))]
                else:
                    lesson_ids = []
                for lid in lesson_ids:
                    dependencies.append({"kind": "lesson", "id": lid, "revision": self.store.one("lessons", lid, db)["revision"]})
                if ref["kind"] == "score":
                    exam_id = self.store.one("scores", ref["id"], db)["exam_id"]
                    dependencies.append({"kind": "exam", "id": exam_id, "revision": self.store.one("exams", exam_id, db)["revision"]})
            for ref in dependencies:
                if ref not in refs:
                    refs.append(ref)
            # Capture all available scoped lesson/exam versions supplied by callers as dependencies;
            # leaf references are checked as well, so a stale report cannot be republished silently.
            if relative is None:
                relative = f"artifacts/{aid}/content.md"
                manifest = "\n\n---\n来源版本：\n" + "\n".join(f"- {r['kind']}:{r['id']}@{r['revision']}" for r in refs)
                atomic_write(self.store.config.stored_file(relative), (text + manifest + "\n").encode())
            db.execute("INSERT INTO artifacts(id,kind,title,path,sources,created_at,validation) VALUES(?,?,?,?,?,?,?)", (aid, kind, title, relative, encode(refs), now(), encode(validation)))
            if workflow:
                from .recordings import Recordings
                Recordings(self.store).attach(workflow, {"id": aid, "kind": kind, "sources": refs,
                    "stale": 0, "available": True}, db)
            self.store.audit(db, "artifact", aid, {"kind": kind})
        return self.read(aid)

    def read(self, artifact_id: str) -> dict:
        row = self.store.one("artifacts", artifact_id)
        row["sources"] = json.loads(row["sources"])
        row["validation"] = json.loads(row["validation"])
        path = self.store.config.stored_file(row["path"])
        row["available"] = path.is_file()
        row["absolute_path"] = str(path)
        if not row["available"]:
            raise WorkbenchError("已登记产物文件缺失，请恢复资料")
        try:
            self.facts.sources(row["sources"])
        except WorkbenchError:
            row["stale"] = 1
        if row["kind"] != "courseware":
            row["text"] = path.read_text(encoding="utf-8")[:24000]
        row["warning"] = "来源已变化，只能作为历史草稿，需按当前事实刷新" if row["stale"] else None
        return row

    def list(self, kind=None, include_stale=False) -> dict:
        with self.store.connect() as db:
            rows = [dict(r) for r in db.execute("SELECT * FROM artifacts WHERE (? IS NULL OR kind=?) AND (?=1 OR stale=0) ORDER BY created_at DESC", (kind, kind, int(include_stale)))]
        current = [self.read(row["id"]) for row in rows]
        return {"artifacts": [row for row in current if include_stale or not row["stale"]]}
