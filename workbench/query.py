from __future__ import annotations

import json

from .config import WorkbenchError
from .facts import Facts, display_points
from .storage import Store


class Query:
    def __init__(self, store: Store):
        self.store = store
        self.facts = Facts(store)

    def pending_recordings(self, limit=20):
        with self.store.connect() as db:
            return [dict(r) for r in db.execute("""SELECT a.id,a.filename,a.received_at,a.byte_length
                FROM assets a WHERE a.kind='audio' AND NOT EXISTS
                (SELECT 1 FROM lesson_assets la WHERE la.asset_id=a.id)
                ORDER BY a.received_at DESC LIMIT ?""", (limit,))]

    def scope(self, class_id=None, student_id=None, since=None, until=None):
        clauses, values = [], []
        if class_id:
            self.store.one("classes", class_id)
            clauses.append("l.class_id=?")
            values.append(class_id)
        if student_id:
            self.store.one("students", student_id)
            # Coverage is the student's enrolled classes, not just the matching events.
            clauses.append("l.class_id IN (SELECT class_id FROM memberships WHERE student_id=?)")
            values.append(student_id)
        if since:
            clauses.append("l.occurred_at>=?")
            values.append(since)
        if until:
            clauses.append("l.occurred_at<=?")
            values.append(until)
        return (" AND ".join(clauses) or "1"), values

    def coverage(self, class_id=None, student_id=None, since=None, until=None) -> dict:
        where, values = self.scope(class_id, student_id, since, until)
        with self.store.connect() as db:
            lessons = [dict(r) for r in db.execute(f"SELECT l.* FROM lessons l WHERE {where} ORDER BY occurred_at,id", values)]
            for lesson in lessons:
                lesson["assets"] = [dict(r) for r in db.execute("SELECT a.id,a.kind,a.provenance,la.start,la.end FROM lesson_assets la JOIN assets a ON a.id=la.asset_id WHERE la.lesson_id=?", (lesson["id"],))]
                for asset in lesson["assets"]:
                    asset["provenance"] = json.loads(asset["provenance"])
                lesson["transcript_count"] = db.execute("SELECT COUNT(DISTINCT t.id) FROM transcripts t JOIN lesson_assets la ON la.asset_id=t.asset_id WHERE la.lesson_id=?", (lesson["id"],)).fetchone()[0]
                lesson["event_count"] = db.execute("SELECT COUNT(*) FROM events WHERE lesson_id=? AND review_status!='rejected'", (lesson["id"],)).fetchone()[0]
            exams = [dict(r) for r in db.execute("SELECT * FROM exams WHERE (? IS NULL OR class_id=?) AND (? IS NULL OR occurred_at>=?) AND (? IS NULL OR occurred_at<=?) ORDER BY occurred_at,id", (class_id, class_id, since, since, until, until))]
            if student_id:
                enrolled = {r[0] for r in db.execute("SELECT class_id FROM memberships WHERE student_id=?", (student_id,))}
                exams = [e for e in exams if e["class_id"] in enrolled]
            counts = {r["state"]: r["n"] for r in db.execute("SELECT state,COUNT(*) n FROM jobs GROUP BY state")}
        return {"workspace_id": self.store.config.workspace_id, "lessons": lessons, "lesson_count": len(lessons),
                "exams": exams, "exam_count": len(exams), "jobs": counts,
                "limitations": "覆盖范围只表示已导入资料；录音和转写完整性需根据原件核对，未记录不等于未发生。"}

    def search(self, text="", class_id=None, student_id=None, since=None, until=None, limit=30, offset=0, aliases=None) -> dict:
        if not isinstance(limit, int) or not 1 <= limit <= 100 or not isinstance(offset, int) or offset < 0:
            raise WorkbenchError("检索分页参数无效")
        if not isinstance(text, str) or len(text) > 300:
            raise WorkbenchError("检索词最长 300 字符")
        terms = [text] if text else []
        if aliases:
            if not isinstance(aliases, list) or len(aliases) > 10 or any(not isinstance(t, str) or not t or len(t) > 100 for t in aliases):
                raise WorkbenchError("检索别名最多 10 个短文本")
            terms += aliases
        # A limited teacher corpus uses literal Unicode substring search. This intentionally
        # handles two-character Chinese words without pretending default FTS tokenization works.
        where, values = self.scope(class_id, student_id, since, until)
        output = []
        with self.store.connect() as db:
            lesson_ids = [r[0] for r in db.execute(f"SELECT l.id FROM lessons l WHERE {where}", values)]
            if lesson_ids:
                marks = ",".join("?" for _ in lesson_ids)
                events = db.execute(f"SELECT * FROM events WHERE lesson_id IN ({marks}) AND review_status!='rejected' ORDER BY lesson_id,id", lesson_ids).fetchall()
                for event in events:
                    if student_id and event["student_id"] != student_id:
                        continue
                    try:
                        self.facts.sources(json.loads(event["sources"]), db)
                    except WorkbenchError:
                        # The old interpretation cannot be used after its evidence changed.
                        continue
                    content = json.loads(event["content"])
                    if terms and not any(term.casefold() in json.dumps(content, ensure_ascii=False).casefold() for term in terms):
                        continue
                    output.append({"type": "event", "lesson_id": event["lesson_id"], "student_id": event["student_id"],
                                   "identity_status": event["identity_status"], "kind": event["kind"], "review_status": event["review_status"],
                                   "content": content, "sources": json.loads(event["sources"]),
                                   "citation": {"kind": "event", "id": event["id"], "revision": event["revision"]}})
                if not student_id:
                    segments = db.execute(f"SELECT DISTINCT s.*,la.lesson_id,t.asset_id,t.version,a.kind asset_kind FROM segments s JOIN transcripts t ON t.id=s.transcript_id JOIN assets a ON a.id=t.asset_id JOIN lesson_assets la ON la.asset_id=t.asset_id WHERE la.lesson_id IN ({marks}) AND t.id=(SELECT t2.id FROM transcripts t2 WHERE t2.asset_id=t.asset_id ORDER BY t2.created_at DESC,t2.id DESC LIMIT 1) AND s.start>=la.start AND (la.end IS NULL OR s.end<=la.end) ORDER BY la.lesson_id,s.start", lesson_ids).fetchall()
                    for segment in segments:
                        current = segment["corrected_text"] if segment["corrected_text"] is not None else segment["text"]
                        if terms and not any(term.casefold() in current.casefold() for term in terms):
                            continue
                        output.append({"type": "segment", "lesson_id": segment["lesson_id"], "asset_id": segment["asset_id"],
                                       "asset_kind": segment["asset_kind"], "transcript_version": segment["version"],
                                       "start": segment["start"], "end": segment["end"], "text": current,
                                       "speaker_local": segment["speaker"], "student_id": None,
                                       "citation": {"kind": "segment", "id": segment["id"], "revision": segment["revision"]}})
            # Score rows can be queried by a student, without exposing another student's transcript identity.
            for score in db.execute("SELECT s.*,e.class_id,e.title,e.occurred_at,q.knowledge_point,q.mapping_status,q.max_points FROM scores s JOIN exams e ON e.id=s.exam_id JOIN exam_questions q ON q.exam_id=s.exam_id AND q.id=s.question_id WHERE (? IS NULL OR e.class_id=?) AND (? IS NULL OR s.student_id=?) AND (? IS NULL OR e.occurred_at>=?) AND (? IS NULL OR e.occurred_at<=?) ORDER BY e.id,s.student_id,s.question_id", (class_id,class_id,student_id,student_id,since,since,until,until)):
                searchable = " ".join(str(score[k] or "") for k in ("title", "knowledge_point", "question_id"))
                if terms and not any(term.casefold() in searchable.casefold() for term in terms): continue
                output.append({"type":"score", "exam_id":score["exam_id"],"student_id":score["student_id"],
                    "question_id":score["question_id"],"score":display_points(score["points"]) if score["points"] is not None else None,
                    "status":score["status"],"cell":score["cell"],"knowledge_point":score["knowledge_point"],"mapping_status":score["mapping_status"],
                    "citation":{"kind":"score","id":score["id"],"revision":score["revision"]}})
        return {"coverage": self.coverage(class_id, student_id, since, until), "matches": output[offset:offset + limit],
                "total_matches": len(output), "offset": offset, "limit": limit, "has_more": offset + limit < len(output),
                "strategy": "structured_scope_plus_literal_unicode_substring", "terms": terms}

    def read(self, kind: str, object_id: str, context=2) -> dict:
        if kind == "event":
            event = self.facts.read_event(object_id)
            try:
                self.facts.sources(event["sources"])
                event["source_changed"] = False
            except WorkbenchError:
                event["source_changed"] = True
                event["warning"] = "来源已更正，原事件解释需要复核，不能作为当前结论。"
            return event
        if kind == "segment":
            if not isinstance(context, int) or not 0 <= context <= 10:
                raise WorkbenchError("上下文范围最多前后各 10 段")
            row = self.store.one("segments", object_id)
            transcript = self.store.one("transcripts", row["transcript_id"])
            with self.store.connect() as db:
                rows = [dict(r) for r in db.execute("SELECT * FROM segments WHERE transcript_id=? AND position BETWEEN ? AND ? ORDER BY position", (row["transcript_id"], row["position"] - context, row["position"] + context))]
            for r in rows:
                r["original_text"] = r["text"]
                r["text"] = r["corrected_text"] if r["corrected_text"] is not None else r["text"]
                r["citation"] = {"kind": "segment", "id": r["id"], "revision": r["revision"]}
            return {"asset_id": transcript["asset_id"], "transcript_version": transcript["version"], "segments": rows}
        if kind == "asset":
            row = self.store.one("assets", object_id)
            row["provenance"] = json.loads(row["provenance"])
            path = self.store.config.stored_file(row["path"])
            row["available"] = path.is_file()
            if row["kind"] == "document" and path.suffix in {".txt", ".md"}:
                row["text"] = path.read_text(encoding="utf-8")[:16000]
                row["truncated"] = path.stat().st_size > 16000
            return row
        if kind == "exam":
            return self.facts.score_stats(object_id)
        if kind == "score":
            row = self.store.one("scores", object_id)
            row["score"] = display_points(row["points"]) if row["points"] is not None else None
            row["citation"] = {"kind": "score", "id": row["id"], "revision": row["revision"]}
            return row
        if kind in {"lesson", "question", "job", "message"}:
            return self.store.one({"lesson": "lessons", "question": "questions", "job": "jobs", "message": "messages"}[kind], object_id)
        raise WorkbenchError("不支持读取此类资料")

    def questions(self, lesson_id=None, status="open", limit=3) -> dict:
        if status not in {"open", "answered", "skipped"} or not isinstance(limit, int) or not 1 <= limit <= 100:
            raise WorkbenchError("问题状态或数量无效")
        with self.store.connect() as db:
            values = (status, lesson_id, lesson_id)
            total = db.execute("SELECT COUNT(*) FROM questions WHERE status=? AND (? IS NULL OR lesson_id=?)", values).fetchone()[0]
            rows = [dict(r) for r in db.execute("SELECT * FROM questions WHERE status=? AND (? IS NULL OR lesson_id=?) ORDER BY created_at,id LIMIT ?", (*values, limit))]
        return {"questions": rows, "total": total, "remaining": total - len(rows)}
