"""Fictional source fixtures exercise native organization, durable confirmation and corrections."""
import copy
import json
import tempfile
import unittest
from pathlib import Path

from workbench.config import Config, WorkbenchError
from workbench.organization import Organization, recording_start
from workbench.service import Workbench
from workbench.recordings import RecordingWorker, Recordings


class OrganizationCase(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="fictional-organization-")
        self.w = Workbench(Config(root=Path(self.temp.name), workspace_id="fictional-organization"))
        self.org = Organization(self.w.store)
        with self.w.store.transaction() as db:
            db.execute("INSERT INTO classes VALUES('c1','虚构班一',NULL)")
            db.execute("INSERT INTO classes VALUES('c2','虚构班二',NULL)")
            db.execute("INSERT INTO students VALUES('s1','虚构张明')")
            db.execute("INSERT INTO students VALUES('s2','虚构张明')")
            db.execute("INSERT INTO memberships VALUES('c1','s1')")
            db.execute("INSERT INTO memberships VALUES('c2','s2')")
        self.assets = []
        self.refs = []
        for i, stamp in enumerate(("080000", "083000")):
            path = Path(self.temp.name) / ("fictional_20261013_" + stamp + ".wav")
            path.write_bytes(f"EXPLICITLY FICTIONAL RECORDING {i}".encode())
            asset = self.w.store.ingest(str(path), "audio")
            self.assets.append(asset["id"])
            self.w.facts.transcript(asset["id"], "fictional-v1", [
                {"start": 600 if i == 0 else 0, "end": 610 if i == 0 else 10, "text": "虚构教师：函数在区间内如何变化？", "speaker":"SPEAKER_00"},
                {"start": 1560 if i == 0 else 1200, "end": 1570 if i == 0 else 1320, "text": "虚构学生：后面的函数值比前面大。", "speaker":"SPEAKER_01"},
            ])
            with self.w.store.connect() as db:
                self.refs.append([{"kind":"segment","id":r["id"],"revision":r["revision"]} for r in db.execute("SELECT s.* FROM segments s JOIN transcripts t ON s.transcript_id=t.id WHERE t.asset_id=? ORDER BY s.position", (asset["id"],))])
        self.proposal = {"title":"虚构函数课堂", "kind":"class", "events":[
            {"title":"虚构提问", "detail":"教师提出问题。", "sources":[self.refs[0][0]]},
            {"title":"虚构回答", "detail":"匿名学生回答。", "question":"这句话是哪位学生说的？", "sources":[self.refs[0][1]]},
            {"title":"虚构后续原文", "detail":"同一节课的后半段。", "sources":self.refs[1]},
        ]}

    def tearDown(self):
        self.temp.cleanup()

    def propose(self, proposal=None):
        self.w.invoke("teacher_organize", {"action":"propose", "asset_ids":self.assets, "activities":[proposal or self.proposal]})
        return self.org.catalog()["activities"][0]

    def act(self, a, action, **values):
        return self.org.command(action,{"id":a["id"],"revision":a["revision"],**values})

    def test_schedule_context_cross_file_confirm_history_native_query(self):
        self.org.save_schedule({"revision":0,"entries":[{"weekday":2,"start":"08:10","end":"08:50","period":"第一节课","class_id":"c1"}]})
        a = self.propose()
        self.assertEqual((a["class_id"],a["class_source"],a["period"]),("c1","schedule","第一节课"))
        self.assertEqual(a["started_at"],"2026-10-13T08:10:00")
        self.assertEqual(a["ended_at"],"2026-10-13T08:52:00")
        target = a["events"][1]
        self.assertEqual(target["at"],"2026-10-13T08:26:00")
        self.assertEqual(len(target["context"]),2)
        self.assertFalse(target["context"][0]["target"])
        with self.w.store.connect() as db:
            self.assertEqual(db.execute("SELECT COUNT(*) FROM lessons").fetchone()[0],0)
        with self.assertRaises(WorkbenchError): self.act(a,"publish")
        a = self.act(a,"resolve",event_id=target["id"],student_id="s1",role="student")
        saved = self.act(a,"publish")
        again = self.act(a,"publish") # Lost response retry is idempotent.
        self.assertEqual(saved["lesson_id"],again["lesson_id"])
        with self.w.store.connect() as db:
            self.assertEqual(db.execute("SELECT COUNT(*) FROM lessons").fetchone()[0],1)
            self.assertEqual(db.execute("SELECT COUNT(*) FROM lesson_assets").fetchone()[0],2)
            self.assertEqual(db.execute("SELECT COUNT(*) FROM events WHERE student_id='s1'").fetchone()[0],1)
        found = self.w.invoke("teacher_query", {"action":"evidence","text":"匿名学生","class_id":"c1"})
        self.assertIn("s1",json.dumps(found))
        reloaded = Organization(Workbench(self.w.store.config).store).catalog()["activities"][0]
        self.assertEqual(reloaded["status"],"saved")

    def test_manual_class_survives_schedule_edits_and_cross_class_identity_rejected(self):
        a = self.propose()
        a = self.act(a,"class",class_id="c2")
        self.org.save_schedule({"revision":0,"entries":[{"weekday":2,"start":"08:10","end":"08:50","period":"第一节课","class_id":"c1"}]})
        current = self.org.catalog()["activities"][0]
        self.assertEqual(current["class_id"],"c2")
        with self.assertRaises(WorkbenchError): self.act(current,"resolve",event_id=a["events"][1]["id"],student_id="s1",role="student")
        current=self.act(current,"resolve",event_id=a["events"][1]["id"],student_id="s2",role="student")
        with self.assertRaises(WorkbenchError): self.act(current,"class",class_id="c1")

    def test_saved_correction_retains_original_revision_and_invalidates_report(self):
        a = self.propose()
        node = a["events"][1]["id"]
        a = self.act(a,"resolve",event_id=node,role="unknown")
        a = self.act(a,"publish")
        event = self.w.facts.read_event("event_" + node)
        report = self.w.artifacts.save("brief","虚构衍生报告",[event["citation"]],text="虚构旧结论")
        a = self.act(a,"note",event_id=node,text="教师明确补充：当时讨论的是任意两点。")
        self.assertEqual(a["status"],"saved")
        effective = self.w.facts.read_event("event_" + node)
        self.assertIn("任意两点",effective["content"]["note"])
        self.assertIsNone(effective["student_id"])
        self.assertTrue(self.w.store.one("artifacts",report["id"])["stale"])
        with self.w.store.connect() as db:
            original=json.loads(db.execute("SELECT original FROM recording_activities").fetchone()[0])
            self.assertNotIn("note",original["events"][1])
            self.assertGreater(db.execute("SELECT COUNT(*) FROM corrections WHERE target_kind='event'").fetchone()[0],0)

    def test_stale_concurrent_missing_and_duplicate_sources_rollback(self):
        incomplete=copy.deepcopy(self.proposal);incomplete["events"].pop()
        with self.assertRaises(WorkbenchError): self.propose(incomplete)
        self.assertEqual(self.org.catalog()["activities"],[])
        a=self.propose()
        with self.assertRaises(WorkbenchError): self.propose()
        self.assertEqual(len(self.org.catalog()["activities"]),1)
        self.act(a,"class",class_id="c1")
        with self.assertRaises(WorkbenchError): self.act(a,"class",class_id="c2")
        ref=self.refs[0][0]
        message=self.w.facts.message("虚构教师纠正原文","fictional-correction")["id"]
        self.w.facts.correct("segment",ref["id"],1,{"text":"虚构更正原文"},message)
        self.assertFalse(self.org.analyzed(self.assets[0]))
        self.assertTrue(self.org.catalog()["activities"][0]["stale"])

    def test_worker_completes_only_from_saved_drafts_and_does_not_generate_reports(self):
        flow=Recordings(self.w.store).enqueue(self.assets[0])
        transcript=self.w.store.connect()
        with transcript as db:
            tid=db.execute("SELECT transcript_id FROM segments WHERE id=?",(self.refs[0][0]["id"],)).fetchone()[0]
        job=self.w.jobs.enqueue("audio","fictional-v1",asset_id=self.assets[0])
        with self.w.store.transaction() as db:
            db.execute("UPDATE jobs SET state='ready',external_id='fictional-asr',result=? WHERE id=?",(json.dumps({"transcript_id":tid}),job["id"]))
        worker=RecordingWorker(self.w.store,analyzer=lambda *_args:self.propose())
        worker.run_once()
        self.assertEqual(self.w.store.one("recording_workflows",flow["id"])["state"],"completed")
        self.assertTrue(Recordings(self.w.store).view(self.assets[0])["complete"])
        with self.w.store.connect() as db:
            self.assertEqual(db.execute("SELECT COUNT(*) FROM artifacts").fetchone()[0],0)
            self.assertEqual(db.execute("SELECT COUNT(*) FROM lessons").fetchone()[0],0)

    def test_filesystem_modified_time_never_becomes_lesson_time(self):
        self.assertIsNone(recording_start({"filename":"unknown.wav","modified_at":"2026-10-13T08:10:00"}))
        self.assertIsNone(recording_start({"filename":"20261332_256199.wav"}))

    def test_native_corrections_refresh_activity_and_reject_older_desktop_edits(self):
        a=self.propose();node=a["events"][1]["id"]
        a=self.act(a,"resolve",event_id=node,role="unknown");a=self.act(a,"publish")
        event=self.w.facts.read_event("event_"+node)
        message=self.w.facts.message("虚构教师确认是学生s1","fictional-native")["id"]
        self.w.facts.correct("event",event["id"],event["revision"],{"student_id":"s1"},message)
        with self.assertRaises(WorkbenchError): self.act(a,"class",class_id="c2")
        refreshed=self.org.catalog()["activities"][0]
        self.assertEqual(refreshed["events"][1]["student_id"],"s1")
        self.assertGreater(refreshed["revision"],a["revision"])

    def test_schedule_clear_still_advances_revision(self):
        first=self.org.save_schedule({"revision":0,"entries":[]})
        self.assertEqual(first["schedule_revision"],1)
        with self.assertRaises(WorkbenchError): self.org.save_schedule({"revision":0,"entries":[]})

    def test_deletion_removes_published_activity_and_its_revision_history(self):
        from workbench.maintenance import Maintenance
        a=self.propose();a=self.act(a,"resolve",event_id=a["events"][1]["id"],role="unknown");a=self.act(a,"publish")
        ops=Maintenance(self.w.store);plan=ops.plan([a["lesson_id"]])
        self.assertIn(a["id"],plan["recording_activities"])
        ops.delete([a["lesson_id"]],confirmation=plan["confirmation"])
        self.assertEqual(self.org.catalog()["activities"],[])
        with self.w.store.connect() as db:
            self.assertEqual(db.execute("PRAGMA foreign_key_check").fetchall(),[])
            self.assertEqual(db.execute("SELECT COUNT(*) FROM corrections WHERE target_kind='recording_activity'").fetchone()[0],0)


if __name__ == "__main__": unittest.main()
