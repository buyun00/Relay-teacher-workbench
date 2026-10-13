"""Recording drafts stay separate from published teaching facts until teacher confirmation."""
from __future__ import annotations

import copy
import json
import re
from datetime import datetime, timedelta

from .config import WorkbenchError
from .facts import Facts, required_text
from .storage import encode, identifier, now


def recording_start(asset):
    # Filenames encode recording start; filesystem modification time is NOT recording start.
    match = re.search(r"(20\d{2})[-_]?([01]\d)[-_]?([0-3]\d)[_ T-]([0-2]\d)[-_:]?([0-5]\d)(?:[-_:]?([0-5]\d))?", asset["filename"])
    if match:
        try:
            return datetime(*[int(n or 0) for n in match.groups()]).isoformat()
        except ValueError:
            pass
    return None


def minutes(value):
    if not re.fullmatch(r"(?:[01]\d|2[0-3]):[0-5]\d", value or ""):
        raise WorkbenchError("时间须为 HH:MM")
    h, m = map(int, value.split(":"))
    return h * 60 + m


class Organization:
    def __init__(self, store):
        self.store = store
        self.facts = Facts(store)

    def catalog(self):
        with self.store.connect() as db:
            classes = [dict(r) for r in db.execute("SELECT * FROM classes ORDER BY name,id")]
            students = [dict(r) for r in db.execute("SELECT s.*,m.class_id FROM students s JOIN memberships m ON m.student_id=s.id ORDER BY s.name,s.id")]
            schedule = [{**json.loads(r["body"]), "id": r["id"], "revision": r["revision"]} for r in db.execute("SELECT * FROM recording_schedule")]
            activities = [self.view(r, db) for r in db.execute("SELECT * FROM recording_activities ORDER BY updated_at DESC")]
            version = db.execute("SELECT value FROM metadata WHERE key='recording_schedule_revision'").fetchone()
        return {"classes": classes, "students": students, "schedule": schedule, "schedule_revision": int(version[0]) if version else 0, "activities": activities}

    def row(self, activity_id, db):
        row = db.execute("SELECT * FROM recording_activities WHERE id=?", (activity_id,)).fetchone()
        if not row:
            raise WorkbenchError("整理记录不存在")
        return dict(row)

    def view(self, row, db):
        body = json.loads(row["body"])
        if row["status"] == "saved" and row["lesson_id"]:
            lesson = self.store.one("lessons", row["lesson_id"], db)
            if lesson["class_id"] != body.get("class_id"):
                body["class_source"] = "manual"
            body.update(class_id=lesson["class_id"], title=lesson["topic"], started_at=lesson["occurred_at"])
            for event in body["events"]:
                fact = db.execute("SELECT * FROM events WHERE id=?", ("event_" + event["id"],)).fetchone()
                if fact:
                    content = json.loads(fact["content"])
                    for key in ("title", "detail", "note", "role", "at", "offset", "speaker_label", "asset_id"):
                        if key in content:
                            event[key] = content[key]
                    event["student_id"] = fact["student_id"]
        stale = False
        for event in body["events"]:
            try:
                self.facts.sources(event["sources"], db)
            except WorkbenchError:
                stale = True
        return {**body, "id": row["id"], "revision": row["revision"], "status": row["status"], "lesson_id": row["lesson_id"], "stale": stale}

    def evidence(self, asset_id=None):
        """Supply complete current transcripts and existing draft versions to the native model."""
        result = self.catalog()
        focus = self.store.one("assets", asset_id) if asset_id else None
        focus_time = recording_start(focus) if focus else None
        with self.store.connect() as db:
            result["recordings"] = []
            for asset in db.execute("SELECT * FROM assets WHERE kind='audio' ORDER BY received_at,id"):
                stamp = recording_start(asset)
                if focus and asset["id"] != asset_id and (not focus_time or not stamp or focus_time[:10] != stamp[:10]):
                    continue
                transcript = db.execute("SELECT * FROM transcripts WHERE asset_id=? ORDER BY created_at DESC,id DESC LIMIT 1", (asset["id"],)).fetchone()
                if not transcript:
                    continue
                segments = [dict(r) for r in db.execute("SELECT id,start,end,speaker,COALESCE(corrected_text,text) text,revision FROM segments WHERE transcript_id=? ORDER BY position", (transcript["id"],))]
                result["recordings"].append({"asset_id": asset["id"], "filename": asset["filename"], "started_at": recording_start(asset), "segments": segments})
        if focus:
            selected = {r["asset_id"] for r in result["recordings"]}
            result["activities"] = [a for a in result["activities"] if selected.intersection(a["asset_ids"])]
        return result

    def match_schedule(self, body, db):
        if body.get("class_source") == "manual" or body.get("kind") != "class" or not body.get("started_at"):
            return
        start = datetime.fromisoformat(body["started_at"])
        end = datetime.fromisoformat(body["ended_at"])
        candidates = []
        for row in db.execute("SELECT body FROM recording_schedule"):
            s = json.loads(row[0])
            if s.get("date") and s["date"] != start.date().isoformat():
                continue
            if not s.get("date") and s["weekday"] != start.isoweekday():
                continue
            lo, hi = start.hour * 60 + start.minute, end.hour * 60 + end.minute
            a, b = minutes(s["start"]), minutes(s["end"])
            if abs(lo - a) <= 10 and min(hi, b) - max(lo, a) >= min(hi - lo, b - a) * .5:
                candidates.append(s)
        body["class_id"] = candidates[0]["class_id"] if len(candidates) == 1 else None
        body["class_source"] = "schedule" if len(candidates) == 1 else "unknown"
        if len(candidates) == 1:
            body["period"] = candidates[0]["period"]

    def propose(self, asset_ids, activities, binding=None):
        """Models propose interpretation, never names. Revisions prevent overwriting teacher edits."""
        if not isinstance(activities, list) or not activities or not asset_ids:
            raise WorkbenchError("需要录音及整理草稿；无有效语音也须保存一条说明记录")
        with self.store.transaction() as db:
            if binding:
                from .recordings import Recordings
                flow = self.store.one("recording_workflows", binding["id"], db)
                Recordings.check(flow, binding)
                if flow["asset_id"] not in asset_ids:
                    raise WorkbenchError("整理结果未包含当前录音")
            for aid in asset_ids:
                self.store.one("assets", aid, db)
            covered = set()
            refs_by_asset = {aid: [] for aid in asset_ids}
            proposed_ids = {p.get("id") for p in activities if p.get("id")}
            claimed_sources = set()
            for saved in db.execute("SELECT id,body FROM recording_activities"):
                if saved["id"] not in proposed_ids:
                    claimed_sources.update(ref["id"] for e in json.loads(saved["body"])["events"] for ref in e["sources"])
            ids = []
            for proposal in activities:
                body = copy.deepcopy(proposal)
                aid = body.pop("id", None) or identifier("activity")
                expected = body.pop("expected_revision", None)
                old = db.execute("SELECT * FROM recording_activities WHERE id=?", (aid,)).fetchone()
                if old and (old["status"] != "draft" or old["revision"] != expected):
                    raise WorkbenchError("草稿已修改或已入库，请重新读取后整理")
                body["title"] = required_text(body.get("title"), "活动标题", 300)
                if body.get("kind") not in {"class", "conversation", "other"}:
                    raise WorkbenchError("活动类型无效")
                if not body.get("events"):
                    raise WorkbenchError("活动须有引用原文的记录")
                if sum(bool(e.get("question")) for e in body["events"]) > 3:
                    raise WorkbenchError("每个活动只提最多3个关键澄清问题，其余内容正常保存")
                body.update(class_id=None, class_source="unknown", notes=[])
                assets = set()
                times = []
                seen = set()
                for event in body["events"]:
                    event["id"] = identifier("node")
                    event["title"] = required_text(event.get("title"), "片段标题", 200)
                    event["detail"] = required_text(event.get("detail"), "片段描述", 4000)
                    event["sources"] = self.facts.sources(event.get("sources"), db)
                    if any(ref["kind"] != "segment" for ref in event["sources"]):
                        raise WorkbenchError("整理片段须引用转写原文")
                    event.update(student_id=None, role="unknown", resolution="pending" if event.get("question") else "clear")
                    event["question"] = str(event.get("question") or "")
                    event["context"] = []
                    for ref in event["sources"]:
                        seg = self.store.one("segments", ref["id"], db)
                        transcript = self.store.one("transcripts", seg["transcript_id"], db)
                        asset_id = transcript["asset_id"]
                        if asset_id not in asset_ids or ref["id"] in seen or ref["id"] in claimed_sources:
                            raise WorkbenchError("片段重复或不属于本次录音")
                        seen.add(ref["id"])
                        assets.add(asset_id)
                        refs_by_asset[asset_id].append(ref)
                        asset = self.store.one("assets", asset_id, db)
                        origin = recording_start(asset)
                        if origin:
                            times += [datetime.fromisoformat(origin) + timedelta(seconds=seg[k]) for k in ("start", "end")]
                        if not event["context"]:
                            event["asset_id"] = asset_id
                            event["offset"] = seg["start"]
                            event["speaker_label"] = seg["speaker"]
                            event["at"] = (datetime.fromisoformat(origin) + timedelta(seconds=seg["start"])).isoformat() if origin else None
                            for neighbor in db.execute("SELECT * FROM segments WHERE transcript_id=? AND position BETWEEN ? AND ? ORDER BY position", (seg["transcript_id"], max(0, seg["position"] - 1), seg["position"] + 1)):
                                event["context"].append({"id": neighbor["id"], "start": neighbor["start"], "text": neighbor["corrected_text"] or neighbor["text"], "speaker": neighbor["speaker"], "target": neighbor["id"] == seg["id"]})
                body["started_at"] = min(times).isoformat() if times else None
                body["ended_at"] = max(times).isoformat() if times else None
                body["period"] = str(body.get("period") or "")
                body["asset_ids"] = sorted(assets)
                self.match_schedule(body, db)
                if old:
                    prior = json.loads(old["body"])
                    # Model cannot silently remove teacher choices; retain them and explicit notes.
                    if prior.get("notes") or any(e.get("resolution") not in {"clear", "pending"} for e in prior["events"]):
                        raise WorkbenchError("此草稿已有教师补充，请新建补充活动，不覆盖原草稿")
                    if prior.get("class_source") == "manual":
                        body.update(class_id=prior.get("class_id"), class_source="manual")
                    db.execute("UPDATE recording_activities SET body=?,revision=revision+1,updated_at=? WHERE id=?", (encode(body), now(), aid))
                    db.execute("DELETE FROM recording_activity_assets WHERE activity_id=?", (aid,))
                else:
                    db.execute("INSERT INTO recording_activities(id,body,original,created_at,updated_at) VALUES(?,?,?,?,?)", (aid, encode(body), encode(body), now(), now()))
                for asset_id in assets:
                    db.execute("INSERT INTO recording_activity_assets VALUES(?,?)", (aid, asset_id))
                ids.append(aid)
                covered.update(assets)
                claimed_sources.update(seen)
            if covered != set(asset_ids):
                raise WorkbenchError("有录音尚未写入整理草稿")
            for asset_id, refs in refs_by_asset.items():
                transcript = db.execute("SELECT id FROM transcripts WHERE asset_id=? ORDER BY created_at DESC,id DESC LIMIT 1", (asset_id,)).fetchone()
                all_ids = {r[0] for r in db.execute("SELECT id FROM segments WHERE transcript_id=?", (transcript[0],))}
                if not all_ids.issubset(claimed_sources):
                    raise WorkbenchError("仍有转写片段未归入活动；完整保留来源后才可完成分析")
                db.execute("INSERT INTO recording_analyses VALUES(?,?,?) ON CONFLICT(asset_id) DO UPDATE SET sources=excluded.sources,updated_at=excluded.updated_at", (asset_id, encode(refs), now()))
            self.store.audit(db, "recording_propose", ",".join(ids), {"assets": asset_ids})
        return {"activity_ids": ids, "persisted": True}

    def analyzed(self, asset_id, db=None):
        if db is None:
            with self.store.connect() as conn:
                return self.analyzed(asset_id, conn)
        row = db.execute("SELECT sources FROM recording_analyses WHERE asset_id=?", (asset_id,)).fetchone()
        if not row:
            return False
        try:
            for ref in json.loads(row[0]):
                self.facts.evidence(ref, db)
        except WorkbenchError:
            return False
        return True

    def command(self, action, payload):
        if action == "schedule":
            return self.save_schedule(payload)
        activity_id = payload["id"]
        message = self.facts.message(encode(payload), "recording:" + activity_id, "desktop")
        with self.store.transaction() as db:
            row = self.row(activity_id, db)
            if action == "publish" and row["status"] == "saved":
                return self.view(row, db)
            if row["revision"] != payload.get("revision"):
                raise WorkbenchError("记录已更新，请刷新后再修改")
            before = self.view(row, db)
            body = {k: v for k, v in before.items() if k not in {"id", "revision", "status", "lesson_id", "stale"}}
            if before["stale"]:
                raise WorkbenchError("转写来源已更新，请重新分析后整理")
            if action == "class":
                class_id = payload.get("class_id")
                if class_id:
                    self.store.one("classes", class_id, db)
                for event in body["events"]:
                    if event.get("student_id") and class_id and not db.execute("SELECT 1 FROM memberships WHERE class_id=? AND student_id=?", (class_id, event["student_id"])).fetchone():
                        raise WorkbenchError("已确认的学生不属于新班级，请先更正说话人")
                body.update(class_id=class_id, class_source="manual")
            elif action in {"resolve", "note"}:
                event = next((e for e in body["events"] if e["id"] == payload.get("event_id")), None)
                if not event:
                    raise WorkbenchError("请选择要补充的片段")
                if action == "resolve":
                    sid = payload.get("student_id")
                    role = payload.get("role", "student" if sid else "unknown")
                    if role not in {"student", "teacher", "unknown"} or (role == "student") != bool(sid):
                        raise WorkbenchError("说话人选择无效")
                    if sid:
                        self.store.one("students", sid, db)
                        if body.get("class_id") and not db.execute("SELECT 1 FROM memberships WHERE class_id=? AND student_id=?", (body["class_id"], sid)).fetchone():
                            raise WorkbenchError("学生不属于所选班级")
                    event.update(student_id=sid, role=role, resolution="unknown" if role == "unknown" else "confirmed")
                else:
                    note = required_text(payload.get("text"), "补充内容", 8000)
                    event["note"] = note
                    event["resolution"] = "confirmed"
                    body["notes"].append({"event_id": event["id"], "text": note, "created_at": now(), "message_id": message["id"]})
                event["confirmation_message_id"] = message["id"]
            elif action == "publish":
                if any(e["resolution"] == "pending" for e in body["events"]):
                    raise WorkbenchError("请处理待确认项；记不清的可保留未知")
            else:
                raise WorkbenchError("整理操作无效")
            lesson_id = row["lesson_id"]
            if action == "publish" or row["status"] == "saved":
                lesson_id = self.publish(db, row, body, message["id"])
            db.execute("UPDATE recording_activities SET body=?,revision=revision+1,status=?,lesson_id=?,updated_at=? WHERE id=?", (encode(body), "saved" if lesson_id else "draft", lesson_id, now(), activity_id))
            after = self.view(self.row(activity_id, db), db)
            db.execute("INSERT INTO corrections VALUES(?,?,?,?,?,?,?)", (identifier("correction"), "recording_activity", activity_id, encode(before), encode(after), message["id"], now()))
            self.store.audit(db, "recording_" + action, activity_id, {"revision": after["revision"]})
        return after

    def publish(self, db, row, body, message_id):
        lesson_id = row["lesson_id"] or "lesson_" + row["id"]
        old = db.execute("SELECT * FROM lessons WHERE id=?", (lesson_id,)).fetchone()
        if old:
            db.execute("UPDATE lessons SET class_id=?,topic=?,occurred_at=?,revision=revision+1 WHERE id=?", (body.get("class_id"), body["title"], body.get("started_at"), lesson_id))
            self.facts.invalidate(db, "lesson", lesson_id)
        else:
            db.execute("INSERT INTO lessons(id,class_id,topic,occurred_at) VALUES(?,?,?,?)", (lesson_id, body.get("class_id"), body["title"], body.get("started_at")))
        ranges = {}
        for event in body["events"]:
            refs = self.facts.sources(event["sources"], db)
            for ref in refs:
                seg = self.store.one("segments", ref["id"], db)
                tid = self.store.one("transcripts", seg["transcript_id"], db)
                ranges.setdefault(tid["asset_id"], []).append((seg["start"], seg["end"]))
            refs.append({"kind": "message", "id": event.get("confirmation_message_id") or message_id, "revision": 1})
            eid = "event_" + event["id"]
            prior = db.execute("SELECT * FROM events WHERE id=?", (eid,)).fetchone()
            content = {k: event.get(k) for k in ("title", "detail", "note", "role", "at", "offset", "speaker_label", "asset_id")}
            values = (event.get("student_id"), "confirmed" if event.get("student_id") else "unknown", encode(content), encode(refs))
            if prior:
                db.execute("UPDATE events SET student_id=?,identity_status=?,content=?,sources=?,revision=revision+1 WHERE id=?", (*values, eid))
                self.facts.invalidate(db, "event", eid)
                after = dict(db.execute("SELECT * FROM events WHERE id=?", (eid,)).fetchone())
                db.execute("INSERT INTO corrections VALUES(?,?,?,?,?,?,?)", (identifier("correction"), "event", eid, encode(dict(prior)), encode(after), message_id, now()))
            else:
                db.execute("INSERT INTO events(id,lesson_id,type,student_id,identity_status,kind,review_status,content,sources,created_at) VALUES(?,?,?,?,?,'inference','confirmed',?,?,?)", (eid, lesson_id, event["title"], *values, now()))
        db.execute("DELETE FROM lesson_assets WHERE lesson_id=?", (lesson_id,))
        for asset_id, spans in ranges.items():
            db.execute("INSERT INTO lesson_assets VALUES(?,?,?,?)", (lesson_id, asset_id, min(s[0] for s in spans), max(s[1] for s in spans)))
        return lesson_id

    def save_schedule(self, payload):
        entries = payload.get("entries")
        if not isinstance(entries, list):
            raise WorkbenchError("课表格式无效")
        with self.store.transaction() as db:
            existing = [dict(r) for r in db.execute("SELECT * FROM recording_schedule ORDER BY id")]
            saved_version = db.execute("SELECT value FROM metadata WHERE key='recording_schedule_revision'").fetchone()
            version = int(saved_version[0]) if saved_version else 0
            if payload.get("revision", 0) != version:
                raise WorkbenchError("课表已更新，请刷新后再保存")
            checked = []
            for entry in entries:
                self.store.one("classes", entry["class_id"], db)
                if not 1 <= entry.get("weekday", 0) <= 7 or minutes(entry["end"]) <= minutes(entry["start"]):
                    raise WorkbenchError("请填写有效的星期和起止时间")
                if entry.get("date"):
                    datetime.strptime(entry["date"], "%Y-%m-%d")
                checked.append({k: entry.get(k) for k in ("class_id", "weekday", "date", "start", "end", "period")})
            db.execute("DELETE FROM recording_schedule")
            db.execute("INSERT INTO metadata VALUES('recording_schedule_revision',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", (str(version + 1),))
            for index, entry in enumerate(checked):
                db.execute("INSERT INTO recording_schedule VALUES(?,?,?)", (identifier("schedule"), encode(entry), version + 1 if index == 0 else 1))
            for row in db.execute("SELECT * FROM recording_activities WHERE status='draft'").fetchall():
                body = json.loads(row["body"])
                if body.get("class_source") != "manual":
                    self.match_schedule(body, db)
                    db.execute("UPDATE recording_activities SET body=?,revision=revision+1 WHERE id=?", (encode(body), row["id"]))
            self.store.audit(db, "recording_schedule", "schedule", {"before": existing, "after": checked})
        return self.catalog()
