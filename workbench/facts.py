from __future__ import annotations

import csv
import hashlib
import json
import math
import re
from datetime import datetime
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP

from .config import WorkbenchError
from .storage import Store, atomic_write, encode, identifier, now


def required_text(value, label: str, limit: int = 16000) -> str:
    if not isinstance(value, str) or not value.strip() or len(value) > limit:
        raise WorkbenchError(f"{label}必须是非空文本，最多 {limit} 字符")
    return value.strip()


def stable_id(value) -> str:
    value = required_text(value, "ID", 100)
    if not re.fullmatch(r"[A-Za-z0-9_-]+", value):
        raise WorkbenchError("ID 只能含字母、数字、下划线和连字符")
    return value


def date_or_none(value):
    if value is None:
        return None
    try:
        datetime.fromisoformat(value)
    except (ValueError, TypeError) as exc:
        raise WorkbenchError("日期必须是 ISO 日期或时间；未知可留空") from exc
    return value


def seconds(value) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or value < 0:
        raise WorkbenchError("时间必须是非负有限秒数")
    return float(value)


def points(value) -> int:
    try:
        d = Decimal(str(value))
        if not d.is_finite() or d < 0 or d != d.quantize(Decimal("0.01")):
            raise InvalidOperation
        return int(d * 100)
    except (InvalidOperation, ValueError, TypeError) as exc:
        raise WorkbenchError("分数必须为非负数，最多两位小数") from exc


def display_points(value: int) -> str:
    return format(Decimal(value) / 100, ".2f")


class Facts:
    def __init__(self, store: Store):
        self.store = store

    def roster(self, path: str, class_id: str, class_name: str) -> dict:
        class_id = stable_id(class_id)
        class_name = required_text(class_name, "班级名称", 200)
        file = self.store.config.input_file(path)
        with file.open(encoding="utf-8-sig", newline="") as stream:
            reader = csv.DictReader(stream)
            if reader.fieldnames != ["student_id", "name"]:
                raise WorkbenchError("名单 CSV 表头必须为 student_id,name")
            rows = list(reader)
        if not rows:
            raise WorkbenchError("名单为空")
        seen = set()
        for row in rows:
            stable_id(row["student_id"])
            required_text(row["name"], "学生姓名", 100)
            if row["student_id"] in seen or None in row:
                raise WorkbenchError("名单有重复 ID 或多余单元格")
            seen.add(row["student_id"])
        asset = self.store.ingest(path, "roster")
        with self.store.transaction() as db:
            old = db.execute("SELECT * FROM classes WHERE id=?", (class_id,)).fetchone()
            if old and old["name"] != class_name:
                raise WorkbenchError("班级 ID 已存在，名称不同；请明确更正")
            db.execute("INSERT OR IGNORE INTO classes(id,name) VALUES(?,?)", (class_id, class_name))
            for row in rows:
                old = db.execute("SELECT name FROM students WHERE id=?", (row["student_id"],)).fetchone()
                if old and old[0] != row["name"]:
                    raise WorkbenchError("学生 ID 已对应其他姓名；不能静默覆盖")
                db.execute("INSERT OR IGNORE INTO students VALUES(?,?)", (row["student_id"], row["name"]))
                db.execute("INSERT OR IGNORE INTO memberships VALUES(?,?)", (class_id, row["student_id"]))
            self.store.audit(db, "roster", class_id, {"asset_id": asset["id"], "students": len(rows)})
        return {"class_id": class_id, "students": len(rows), "asset_id": asset["id"]}

    def lesson(self, lesson_id: str, topic: str, class_id=None, occurred_at=None) -> dict:
        lesson_id = stable_id(lesson_id)
        topic = required_text(topic, "课题", 300)
        occurred_at = date_or_none(occurred_at)
        with self.store.transaction() as db:
            if class_id:
                self.store.one("classes", class_id, db)
            row = db.execute("SELECT * FROM lessons WHERE id=?", (lesson_id,)).fetchone()
            if row:
                if (row["class_id"], row["topic"], row["occurred_at"]) != (class_id, topic, occurred_at):
                    raise WorkbenchError("课次 ID 已存在但信息不同")
            else:
                db.execute("INSERT INTO lessons(id,class_id,topic,occurred_at) VALUES(?,?,?,?)", (lesson_id, class_id, topic, occurred_at))
        return self.store.one("lessons", lesson_id)

    def link_asset(self, lesson_id: str, asset_id: str, start=0, end=None) -> dict:
        start = seconds(start)
        end = seconds(end) if end is not None else None
        if end is not None and end <= start:
            raise WorkbenchError("课次片段结束时间必须大于开始时间")
        with self.store.transaction() as db:
            self.store.one("lessons", lesson_id, db)
            self.store.one("assets", asset_id, db)
            old = db.execute("SELECT end FROM lesson_assets WHERE lesson_id=? AND asset_id=? AND start=?", (lesson_id, asset_id, start)).fetchone()
            if old and old[0] != end:
                raise WorkbenchError("该课次片段已存在，范围不同")
            db.execute("INSERT OR IGNORE INTO lesson_assets VALUES(?,?,?,?)", (lesson_id, asset_id, start, end))
            if not old:
                db.execute("UPDATE lessons SET revision=revision+1 WHERE id=?", (lesson_id,))
                self.invalidate(db, "lesson", lesson_id)
        return {"lesson_id": lesson_id, "asset_id": asset_id, "start": start, "end": end}

    def transcript(self, asset_id: str, version: str, segments: list) -> dict:
        self.store.one("assets", asset_id)
        version = stable_id(version)
        if not isinstance(segments, list) or not segments or len(segments) > 50000:
            raise WorkbenchError("转写须包含 1—50000 个片段")
        normalized = []
        previous = -1
        for segment in segments:
            start, end = seconds(segment["start"]), seconds(segment["end"])
            if end < start or start < previous:
                raise WorkbenchError("转写时间范围无效或片段未按时间排序")
            previous = start
            speaker = segment.get("speaker")
            if speaker is not None:
                required_text(speaker, "本录音说话人标签", 100)
            normalized.append({"start": start, "end": end, "text": required_text(segment["text"], "片段文本"), "speaker": speaker})
        tid = "transcript_" + hashlib.sha256((asset_id + ":" + version).encode()).hexdigest()[:24]
        relative = f"transcripts/{tid}/transcript.json"
        data = {"asset_id": asset_id, "version": version, "segments": normalized}
        with self.store.transaction() as db:
            old = db.execute("SELECT * FROM transcripts WHERE id=?", (tid,)).fetchone()
            if old:
                saved = self.store.config.stored_file(old["path"])
                if not saved.is_file() or json.loads(saved.read_text(encoding="utf-8")) != data:
                    raise WorkbenchError("相同转写版本的内容不同或原文件缺失")
                return {"transcript_id": tid, "segments": len(normalized), "duplicate": True}
            atomic_write(self.store.config.stored_file(relative), encode(data).encode())
            db.execute("INSERT INTO transcripts VALUES(?,?,?,?,?)", (tid, asset_id, version, relative, now()))
            for i, segment in enumerate(normalized):
                db.execute("INSERT INTO segments(id,transcript_id,position,start,end,text,speaker) VALUES(?,?,?,?,?,?,?)", (f"{tid}_s{i:05d}", tid, i, segment["start"], segment["end"], segment["text"], segment["speaker"]))
            self.store.audit(db, "transcript", tid, {"segments": len(normalized)})
            for lesson in db.execute("SELECT lesson_id FROM lesson_assets WHERE asset_id=?", (asset_id,)).fetchall():
                db.execute("UPDATE lessons SET revision=revision+1 WHERE id=?", (lesson[0],))
                self.invalidate(db, "lesson", lesson[0])
        return {"transcript_id": tid, "segments": len(normalized), "duplicate": False}

    def transcript_file(self, path: str, lesson_id: str, version="import-v1") -> dict:
        self.store.one("lessons", lesson_id)
        source = self.store.config.input_file(path)
        try:
            data = json.loads(source.read_text(encoding="utf-8"))
        except (ValueError, UnicodeError) as exc:
            raise WorkbenchError("转写文件必须是 UTF-8 JSON") from exc
        if not isinstance(data, dict) or not isinstance(data.get("segments"), list):
            raise WorkbenchError("转写 JSON 必须有 segments 数组")
        # A supplied transcript is cited as an imported document; it is never claimed to prove an unseen audio.
        asset = self.store.ingest(path, "transcript", {"origin": "imported_transcript", "audio_verified": False})
        result = self.transcript(asset["id"], version, data["segments"])
        self.link_asset(lesson_id, asset["id"])
        return {**result, "asset_id": asset["id"], "audio_verified": False}

    def message(self, text: str, session_id: str, platform="cli", sender_id=None, external_ref=None) -> dict:
        text = required_text(text, "教师消息", 100000)
        session_id = required_text(session_id, "会话 ID", 200)
        # Only trusted host callbacks/operator CLI call this; it is not exposed as an agent tool.
        digest = hashlib.sha256(encode([session_id, external_ref, text]).encode()).hexdigest()[:24]
        mid = "msg_" + digest
        with self.store.transaction() as db:
            db.execute("INSERT OR IGNORE INTO messages VALUES(?,?,?,?,?,?,?)", (mid, session_id, platform, sender_id, external_ref, text, now()))
        return self.store.one("messages", mid)

    def evidence(self, ref: dict, db=None) -> dict:
        if not isinstance(ref, dict) or ref.get("kind") not in {"segment", "event", "message", "score", "lesson", "exam", "asset"}:
            raise WorkbenchError("证据引用类型无效")
        table = {"segment": "segments", "event": "events", "message": "messages", "score": "scores", "lesson": "lessons", "exam": "exams", "asset": "assets"}[ref["kind"]]
        row = self.store.one(table, ref.get("id"), db)
        current = row.get("revision", 1)
        if ref.get("revision") != current:
            raise WorkbenchError(f"证据版本过期或缺失：{ref.get('id')}，当前版本 {current}")
        if ref["kind"] == "event" and row["review_status"] == "rejected":
            raise WorkbenchError("已否定的事件不能作为有效证据")
        if ref["kind"] == "event":
            for source in json.loads(row["sources"]):
                self.evidence(source, db)
        if ref["kind"] == "segment":
            transcript = self.store.one("transcripts", row["transcript_id"], db)
            if db is None:
                with self.store.connect() as conn:
                    latest = conn.execute("SELECT id FROM transcripts WHERE asset_id=? ORDER BY created_at DESC,id DESC LIMIT 1", (transcript["asset_id"],)).fetchone()[0]
            else:
                latest = db.execute("SELECT id FROM transcripts WHERE asset_id=? ORDER BY created_at DESC,id DESC LIMIT 1", (transcript["asset_id"],)).fetchone()[0]
            if latest != transcript["id"]:
                raise WorkbenchError("片段属于历史转写版本，请读取当前转写")
        return {"kind": ref["kind"], "id": row["id"], "revision": current}

    def sources(self, values: list, db=None) -> list:
        if not isinstance(values, list) or not values or len(values) > 200:
            raise WorkbenchError("需要 1—200 条有效来源")
        return [self.evidence(ref, db) for ref in values]

    def event(self, lesson_id: str, event_type: str, content: dict, sources: list,
              kind="observed", student_id=None, confirmation_message_id=None, event_id=None) -> dict:
        event_id = stable_id(event_id) if event_id else identifier("event")
        event_type = required_text(event_type, "事件类型", 80)
        if not isinstance(content, dict) or not content or len(encode(content)) > 24000:
            raise WorkbenchError("事件内容必须是非空对象，最多 24000 字符")
        if kind not in {"observed", "inference", "teacher_observation"}:
            raise WorkbenchError("记录性质无效")
        with self.store.transaction() as db:
            lesson = self.store.one("lessons", lesson_id, db)
            refs = self.sources(sources, db)
            if kind == "teacher_observation" and not any(r["kind"] == "message" for r in refs):
                raise WorkbenchError("教师观察需要教师消息来源")
            for ref in refs:
                if ref["kind"] == "segment":
                    seg = self.store.one("segments", ref["id"], db)
                    transcript = self.store.one("transcripts", seg["transcript_id"], db)
                    linked = db.execute("SELECT 1 FROM lesson_assets WHERE lesson_id=? AND asset_id=? AND start<=? AND (end IS NULL OR end>=?)", (lesson_id, transcript["asset_id"], seg["start"], seg["end"])).fetchone()
                    if not linked:
                        raise WorkbenchError("片段不在这节课已关联的资料范围内")
            if student_id:
                self.store.one("students", student_id, db)
                if lesson["class_id"] and not db.execute("SELECT 1 FROM memberships WHERE class_id=? AND student_id=?", (lesson["class_id"], student_id)).fetchone():
                    raise WorkbenchError("学生不属于该课次班级")
                if not confirmation_message_id:
                    raise WorkbenchError("实名归属需要教师确认消息；否则保留未知")
                self.store.one("messages", confirmation_message_id, db)
                confirmation = {"kind": "message", "id": confirmation_message_id, "revision": 1}
                if confirmation not in refs:
                    refs.append(confirmation)
            old = db.execute("SELECT * FROM events WHERE id=?", (event_id,)).fetchone()
            values = (lesson_id, event_type, student_id, "confirmed" if student_id else "unknown", kind,
                      "confirmed" if kind == "teacher_observation" else "unreviewed", encode(content), encode(refs))
            if old:
                if tuple(old[k] for k in ("lesson_id", "type", "student_id", "identity_status", "kind", "review_status", "content", "sources")) != values:
                    raise WorkbenchError("事件 ID 已存在但内容不同，必须通过更正工具修改")
            else:
                db.execute("INSERT INTO events(id,lesson_id,type,student_id,identity_status,kind,review_status,content,sources,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)", (event_id, *values, now()))
                self.store.audit(db, "event", event_id, {"kind": kind})
                db.execute("UPDATE lessons SET revision=revision+1 WHERE id=?", (lesson_id,))
                self.invalidate(db, "lesson", lesson_id)
        return self.read_event(event_id)

    def read_event(self, event_id: str) -> dict:
        row = self.store.one("events", event_id)
        row["content"] = json.loads(row["content"])
        row["sources"] = json.loads(row["sources"])
        row["citation"] = {"kind": "event", "id": row["id"], "revision": row["revision"]}
        return row

    def question(self, text: str, lesson_id: str, event_id=None) -> dict:
        text = required_text(text, "待确认问题", 2000)
        with self.store.transaction() as db:
            self.store.one("lessons", lesson_id, db)
            if event_id and self.store.one("events", event_id, db)["lesson_id"] != lesson_id:
                raise WorkbenchError("问题与事件课次不一致")
            old = db.execute("SELECT id FROM questions WHERE lesson_id=? AND event_id IS ? AND text=? AND status='open'", (lesson_id, event_id, text)).fetchone()
            qid = old[0] if old else identifier("question")
            if not old:
                db.execute("INSERT INTO questions(id,event_id,lesson_id,text,created_at) VALUES(?,?,?,?,?)", (qid, event_id, lesson_id, text, now()))
        return self.store.one("questions", qid)

    def invalidate(self, db, kind: str, target_id: str):
        # The first version is deliberately conservative: transitive dependencies are followed.
        direct = {(kind, target_id)}
        if kind == "event":
            direct.add(("lesson", self.store.one("events", target_id, db)["lesson_id"]))
        elif kind == "segment":
            seg = self.store.one("segments", target_id, db)
            transcript = self.store.one("transcripts", seg["transcript_id"], db)
            for lesson in db.execute("SELECT lesson_id FROM lesson_assets WHERE asset_id=?", (transcript["asset_id"],)):
                direct.add(("lesson", lesson[0]))
            for event in db.execute("SELECT * FROM events"):
                if any(r["kind"] == "segment" and r["id"] == target_id for r in json.loads(event["sources"])):
                    direct.add(("event", event["id"]))
        elif kind == "score":
            direct.add(("exam", self.store.one("scores", target_id, db)["exam_id"]))
        count = 0
        for row in db.execute("SELECT id,sources FROM artifacts WHERE stale=0").fetchall():
            if any((r["kind"], r["id"]) in direct for r in json.loads(row["sources"])):
                db.execute("UPDATE artifacts SET stale=1 WHERE id=?", (row["id"],))
                count += 1
        return count

    def correct(self, target_kind: str, target_id: str, expected_revision: int, changes: dict,
                message_id: str, question_id=None) -> dict:
        if target_kind not in {"event", "segment", "lesson", "score"}:
            raise WorkbenchError("不支持更正此类型")
        table = {"event": "events", "segment": "segments", "lesson": "lessons", "score": "scores"}[target_kind]
        allowed = {"event": {"student_id", "review_status", "content", "sources"}, "segment": {"text"},
                   "lesson": {"class_id", "topic", "occurred_at"}, "score": {"score", "status"}}[target_kind]
        if not isinstance(changes, dict) or not changes or set(changes) - allowed:
            raise WorkbenchError("更正字段无效")
        with self.store.transaction() as db:
            before = self.store.one(table, target_id, db)
            self.store.one("messages", message_id, db)
            if before["revision"] != expected_revision:
                raise WorkbenchError("更正目标已变化，请先读取当前版本")
            if question_id:
                question = self.store.one("questions", question_id, db)
                if question["status"] != "open" or (question["event_id"] and question["event_id"] != target_id):
                    raise WorkbenchError("待确认问题已处理或不对应此事件")
            updates = {}
            if target_kind == "event":
                if "student_id" in changes:
                    student_id = changes["student_id"]
                    if student_id:
                        self.store.one("students", student_id, db)
                        lesson = self.store.one("lessons", before["lesson_id"], db)
                        if lesson["class_id"] and not db.execute("SELECT 1 FROM memberships WHERE class_id=? AND student_id=?", (lesson["class_id"], student_id)).fetchone():
                            raise WorkbenchError("学生不属于此班级")
                    updates.update(student_id=student_id, identity_status="confirmed" if student_id else "unknown")
                if "review_status" in changes:
                    if changes["review_status"] not in {"confirmed", "rejected", "unreviewed"}:
                        raise WorkbenchError("审核状态无效")
                    updates["review_status"] = changes["review_status"]
                if "content" in changes:
                    if not isinstance(changes["content"], dict) or not changes["content"]:
                        raise WorkbenchError("事件内容必须为非空对象")
                    updates["content"] = encode(changes["content"])
                    updates["kind"] = "teacher_observation"
                refs = self.sources(changes["sources"], db) if "sources" in changes else json.loads(before["sources"])
                if any(r["kind"] == "event" and r["id"] == target_id for r in refs):
                    raise WorkbenchError("事件不能引用自身")
                refs.append({"kind": "message", "id": message_id, "revision": 1})
                updates["sources"] = encode(refs)
            elif target_kind == "segment":
                updates["corrected_text"] = required_text(changes["text"], "更正文字")
            elif target_kind == "lesson":
                updates = dict(changes)
                if "class_id" in updates and updates["class_id"]:
                    self.store.one("classes", updates["class_id"], db)
                    for event in db.execute("SELECT student_id FROM events WHERE lesson_id=? AND student_id IS NOT NULL", (target_id,)):
                        if not db.execute("SELECT 1 FROM memberships WHERE class_id=? AND student_id=?", (updates["class_id"], event[0])).fetchone():
                            raise WorkbenchError("现有实名事件学生不属于新班级，请先处理身份归属")
                if "occurred_at" in updates:
                    date_or_none(updates["occurred_at"])
                if "topic" in updates:
                    required_text(updates["topic"], "课题", 300)
            else:
                status = changes.get("status", "scored" if "score" in changes else before["status"])
                if status not in {"scored", "missing", "absent", "ungraded"}:
                    raise WorkbenchError("成绩状态无效")
                value = points(changes["score"]) if status == "scored" and "score" in changes else before["points"] if status == "scored" else None
                max_score = db.execute("SELECT max_points FROM exam_questions WHERE exam_id=? AND id=?", (before["exam_id"], before["question_id"])).fetchone()[0]
                if status == "scored" and (value is None or value > max_score):
                    raise WorkbenchError("成绩缺失或超过满分")
                updates.update(points=value, status=status)
                db.execute("UPDATE exams SET revision=revision+1 WHERE id=?", (before["exam_id"],))
            assignments = ",".join(k + "=?" for k in updates)
            db.execute(f"UPDATE {table} SET {assignments},revision=revision+1 WHERE id=?", (*updates.values(), target_id))
            after = self.store.one(table, target_id, db)
            if target_kind == "event":
                db.execute("UPDATE lessons SET revision=revision+1 WHERE id=?", (before["lesson_id"],))
            elif target_kind == "segment":
                transcript = self.store.one("transcripts", before["transcript_id"], db)
                db.execute("UPDATE lessons SET revision=revision+1 WHERE id IN (SELECT lesson_id FROM lesson_assets WHERE asset_id=?)", (transcript["asset_id"],))
            cid = identifier("correction")
            db.execute("INSERT INTO corrections VALUES(?,?,?,?,?,?,?)", (cid, target_kind, target_id, encode(before), encode(after), message_id, now()))
            invalidated = self.invalidate(db, target_kind, target_id)
            if question_id:
                db.execute("UPDATE questions SET status='answered',response=?,response_message_id=?,resolved_at=? WHERE id=?", (encode(changes), message_id, now(), question_id))
            self.store.audit(db, "correct", target_id, {"revision": after["revision"], "invalidated": invalidated})
        return {"correction_id": cid, "target_id": target_id, "revision": after["revision"], "invalidated_artifacts": invalidated}

    def import_scores(self, path: str, exam_id: str, class_id: str, title: str, questions: list, occurred_at=None) -> dict:
        exam_id = stable_id(exam_id)
        self.store.one("classes", class_id)
        title = required_text(title, "测验名称", 300)
        occurred_at = date_or_none(occurred_at)
        if not isinstance(questions, list) or not questions:
            raise WorkbenchError("需要题目和满分映射")
        mapping = {}
        for q in questions:
            qid = stable_id(q["id"])
            if qid in mapping:
                raise WorkbenchError("题目 ID 重复")
            maximum = points(q["max_score"])
            status = q.get("mapping_status", "unknown")
            topic = q.get("knowledge_point")
            if maximum <= 0 or status not in {"unknown", "proposed", "confirmed"} or (topic and status == "unknown"):
                raise WorkbenchError("满分或知识点映射状态无效；未知映射不能直接带知识点结论")
            mapping[qid] = (maximum, topic, status)
        file = self.store.config.input_file(path)
        with file.open(encoding="utf-8-sig", newline="") as stream:
            reader = csv.DictReader(stream)
            headers = reader.fieldnames
            rows = list(reader)
        expected = {"student_id", *mapping}
        if not headers or set(headers) not in (expected, expected | {"total"}) or len(headers) != len(set(headers)):
            raise WorkbenchError("成绩表必须包含 student_id 和全部题号，可选 total；表头不能重复")
        if not rows:
            raise WorkbenchError("成绩表为空")
        parsed = []
        seen = set()
        with self.store.connect() as db:
            members = {r[0] for r in db.execute("SELECT student_id FROM memberships WHERE class_id=?", (class_id,))}
        for row_number, row in enumerate(rows, 2):
            sid = row["student_id"]
            if sid not in members or sid in seen or None in row:
                raise WorkbenchError(f"第 {row_number} 行学生 ID 不在名单、重复或有多余单元格")
            seen.add(sid)
            total = 0
            all_scored = True
            for qid, (maximum, _, _) in mapping.items():
                raw = row[qid]
                if raw is None:
                    raise WorkbenchError(f"第 {row_number} 行单元格不足")
                raw = raw.strip()
                status = {"": "missing", "缺考": "absent", "未批改": "ungraded"}.get(raw, "scored")
                value = points(raw) if status == "scored" else None
                if value is not None and value > maximum:
                    raise WorkbenchError(f"第 {row_number} 行 {qid} 超过满分")
                total += value or 0
                all_scored &= status == "scored"
                column = headers.index(qid) + 1
                letters = ""
                while column:
                    column, digit = divmod(column - 1, 26)
                    letters = chr(65 + digit) + letters
                parsed.append((sid, qid, value, status, letters + str(row_number)))
            if "total" in row and row["total"].strip():
                if not all_scored or points(row["total"]) != total:
                    raise WorkbenchError(f"第 {row_number} 行总分与题分不一致或题分不完整")
        asset = self.store.ingest(path, "scores")
        with self.store.transaction() as db:
            old = db.execute("SELECT * FROM exams WHERE id=?", (exam_id,)).fetchone()
            if old:
                old_mapping = {r["id"]: (r["max_points"], r["knowledge_point"], r["mapping_status"]) for r in db.execute("SELECT * FROM exam_questions WHERE exam_id=?", (exam_id,))}
                if old["source_asset_id"] != asset["id"] or old["class_id"] != class_id or old_mapping != mapping or old["title"] != title or old["occurred_at"] != occurred_at:
                    raise WorkbenchError("测验 ID 已存在但原表或映射不同；请使用新 ID 或明确更正")
                return {"exam_id": exam_id, "duplicate": True, "rows": len(rows)}
            db.execute("INSERT INTO exams(id,class_id,title,occurred_at,source_asset_id) VALUES(?,?,?,?,?)", (exam_id, class_id, title, occurred_at, asset["id"]))
            for qid, (maximum, topic, status) in mapping.items():
                db.execute("INSERT INTO exam_questions VALUES(?,?,?,?,?)", (exam_id, qid, maximum, topic, status))
            for sid, qid, value, status, cell in parsed:
                score_id = "score_" + hashlib.sha256(encode([exam_id, sid, qid]).encode()).hexdigest()[:24]
                db.execute("INSERT INTO scores(id,exam_id,question_id,student_id,points,status,cell,source_asset_id) VALUES(?,?,?,?,?,?,?,?)", (score_id, exam_id, qid, sid, value, status, cell, asset["id"]))
            self.store.audit(db, "scores", exam_id, {"rows": len(rows), "source": asset["id"]})
        return {"exam_id": exam_id, "duplicate": False, "rows": len(rows), "asset_id": asset["id"]}

    def score_stats(self, exam_id: str, student_id=None) -> dict:
        exam = self.store.one("exams", exam_id)
        if student_id:
            self.store.one("students", student_id)
        output = []
        with self.store.connect() as db:
            if student_id and not db.execute("SELECT 1 FROM memberships WHERE class_id=? AND student_id=?", (exam["class_id"], student_id)).fetchone():
                raise WorkbenchError("学生不属于测验班级")
            members = db.execute("SELECT COUNT(*) FROM memberships WHERE class_id=?", (exam["class_id"],)).fetchone()[0]
            if student_id: members = 1
            for question in db.execute("SELECT * FROM exam_questions WHERE exam_id=? ORDER BY id", (exam_id,)):
                rows = db.execute("SELECT * FROM scores WHERE exam_id=? AND question_id=? AND (? IS NULL OR student_id=?)", (exam_id, question["id"], student_id, student_id)).fetchall()
                values = [r["points"] for r in rows if r["status"] == "scored"]
                counts = {s: sum(r["status"] == s for r in rows) for s in ("scored", "missing", "absent", "ungraded")}
                mean = (Decimal(sum(values)) / 100 / len(values)).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP) if values else None
                rate = (Decimal(sum(values)) * 100 / (question["max_points"] * len(values))).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP) if values else None
                output.append({"question_id": question["id"], "max_score": display_points(question["max_points"]),
                               "knowledge_point": question["knowledge_point"], "mapping_status": question["mapping_status"],
                               "counts": {**counts, "not_imported": members - len(rows)}, "denominator": len(values),
                               "sum_score": display_points(sum(values)), "mean_score": str(mean) if mean is not None else None,
                               "score_rate_percent": str(rate) if rate is not None else None,
                               "sources": [{"kind": "score", "id": r["id"], "revision": r["revision"], "cell": r["cell"]} for r in rows]})
        return {"exam_id": exam_id, "class_id": exam["class_id"], "student_id": student_id, "roster_size": members,
                "citation": {"kind": "exam", "id": exam_id, "revision": exam["revision"]}, "questions": output}
