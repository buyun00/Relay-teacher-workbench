from __future__ import annotations

import json
import shutil
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

from workbench.config import Config, WorkbenchError
from workbench.courseware import Courseware
from workbench.native import register_plugin
from workbench.service import Workbench
from workbench.storage import Store


class TeacherCase(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name) / "teacher"
        self.w = Workbench(Config(root=self.root, import_roots=(self.root / "inbox",)))
        for source in Path(__file__).with_name("fixtures").iterdir():
            shutil.copy2(source, self.root / "inbox" / source.name)
        self.w.facts.roster(self.path("roster.csv"), "demo_class", "虚构班级")
        for n in (1, 2):
            self.w.facts.lesson(f"demo_l{n}", "定义域" if n == 1 else "单调性", "demo_class", f"2026-10-0{n}")
            self.w.facts.transcript_file(self.path(f"lesson{n}.json"), f"demo_l{n}")
        self.hits = self.w.query.search("", class_id="demo_class")["matches"]
        self.ref = next(h["citation"] for h in self.hits if h["lesson_id"] == "demo_l1" and "根号下大于" in h["text"])

    def tearDown(self):
        self.temp.cleanup()

    def path(self, name):
        return str(self.root / "inbox" / name)

    def event(self):
        return self.w.facts.event("demo_l1", "answer", {"issue": "定义域端点遗漏"}, [self.ref], event_id="demo_event")

    def message(self, text="这名学生是虚构学生乙", session="chat2"):
        return self.w.facts.message(text, session)["id"]

    def scores(self):
        return self.w.facts.import_scores(self.path("scores.csv"), "demo_exam", "demo_class", "虚构测验",
            [{"id": "q1", "max_score": 10}, {"id": "q2", "max_score": 10, "knowledge_point": "定义域", "mapping_status": "confirmed"}])

    def test_same_content_renamed_is_one_asset(self):
        shutil.copy2(self.path("lesson1.json"), self.path("renamed.json"))
        first = self.w.store.ingest(self.path("lesson1.json"), "transcript")
        again = self.w.store.ingest(self.path("renamed.json"), "transcript")
        self.assertEqual(first["id"], again["id"])
        self.assertTrue(again["duplicate"])
        Path(self.path("renamed.json")).write_text("different", encoding="utf-8")
        self.assertNotEqual(first["id"], self.w.store.ingest(self.path("renamed.json"), "document")["id"])

    def test_import_path_cannot_read_other_space(self):
        outside = Path(self.temp.name) / "other.md"
        outside.write_text("another workspace", encoding="utf-8")
        with self.assertRaises(WorkbenchError):
            self.w.store.ingest(str(outside), "document")
        with self.assertRaises(WorkbenchError):
            self.w.store.config.stored_file("../other.md")

    def test_cross_lesson_chinese_short_query_and_coverage(self):
        result = self.w.query.search("定义域", class_id="demo_class", limit=1)
        self.assertEqual(result["coverage"]["lesson_count"], 2)
        self.assertTrue(result["has_more"])
        self.assertGreater(result["total_matches"], 1)
        aliases = self.w.query.search("递增", aliases=["增减"])
        self.assertEqual(aliases["total_matches"], 1)
        scoped = self.w.query.search("定义域", since="2026-10-02")
        self.assertEqual({h["lesson_id"] for h in scoped["matches"]}, {"demo_l2"})

    def test_speaker_tags_never_imply_student_identity(self):
        self.event()
        self.assertTrue(all(h.get("student_id") is None for h in self.w.query.search("")["matches"]))
        self.assertEqual(self.w.query.search("", student_id="demo_s01")["total_matches"], 0)
        with self.assertRaises(WorkbenchError):
            self.w.facts.event("demo_l1", "answer", {"x": "y"}, [self.ref], student_id="demo_s01")

    def test_correction_cross_session_and_stale_reports(self):
        e = self.event()
        a = self.w.artifacts.save("brief", "虚构复盘", [e["citation"]], text="未知学生遗漏端点")
        q = self.w.facts.question("是哪位学生？", "demo_l1", e["id"])
        self.w.facts.correct("event", e["id"], 1, {"student_id": "demo_s02", "review_status": "confirmed"}, self.message(), q["id"])
        fresh = Workbench(self.w.store.config)
        self.assertEqual(fresh.query.search("", student_id="demo_s02")["total_matches"], 1)
        self.assertEqual(fresh.query.search("", student_id="demo_s01")["total_matches"], 0)
        self.assertTrue(fresh.artifacts.read(a["id"])["stale"])
        self.assertEqual(fresh.store.one("questions", q["id"])["status"], "answered")
        with self.assertRaises(WorkbenchError):
            fresh.facts.correct("event", e["id"], 1, {"student_id": "demo_s01"}, self.message())
        with fresh.store.connect() as db:
            self.assertEqual(db.execute("SELECT COUNT(*) FROM corrections").fetchone()[0], 1)

    def test_transcript_correction_preserves_original_and_blocks_old_interpretation(self):
        e = self.event()
        a = self.w.artifacts.save("brief", "虚构复盘", [e["citation"]], text="旧解释")
        seg = self.w.store.one("segments", self.ref["id"])
        tr = self.w.store.one("transcripts", seg["transcript_id"])
        raw = self.w.store.config.stored_file(tr["path"]).read_bytes()
        self.w.facts.correct("segment", seg["id"], 1, {"text": "我知道根号下应当大于等于零。"}, self.message("原话识别错了"))
        self.assertEqual(self.w.store.config.stored_file(tr["path"]).read_bytes(), raw)
        self.assertTrue(self.w.query.read("event", e["id"])["source_changed"])
        self.assertTrue(self.w.artifacts.read(a["id"])["stale"])
        self.assertFalse(any(h["type"] == "event" for h in self.w.query.search("")["matches"]))

    def test_wrong_lesson_source_is_rejected(self):
        with self.assertRaises(WorkbenchError):
            self.w.facts.event("demo_l2", "answer", {"a": "b"}, [self.ref])

    def test_fabricated_and_old_citations_are_rejected(self):
        for ref in ({"kind": "segment", "id": "missing", "revision": 1}, {**self.ref, "revision": 999}):
            with self.assertRaises(WorkbenchError):
                self.w.artifacts.save("brief", "fake", [ref], text="fake")

    def test_zero_missing_absent_ungraded_have_distinct_denominators(self):
        self.scores()
        result = self.w.facts.score_stats("demo_exam")
        q1, q2 = result["questions"]
        self.assertEqual(q1["counts"], {"scored": 2, "missing": 0, "absent": 1, "ungraded": 1, "not_imported": 0})
        self.assertEqual((q1["denominator"], q1["mean_score"], q1["score_rate_percent"]), (2, "4.00", "40.00"))
        self.assertEqual((q2["counts"]["missing"], q2["mean_score"]), (1, "5.00"))
        self.assertEqual(q1["sources"][0]["cell"], "B2")

    def test_invalid_scores_do_not_partially_commit(self):
        for content in ("student_id,q1,total\ndemo_s01,11,11\n", "student_id,q1,total\ndemo_s01,6,7\n", "student_id,q1\ndemo_s01,1\ndemo_s01,2\n"):
            Path(self.path("bad.csv")).write_text(content, encoding="utf-8")
            with self.assertRaises(WorkbenchError):
                self.w.facts.import_scores(self.path("bad.csv"), "bad_exam", "demo_class", "bad", [{"id": "q1", "max_score": 10}])
        with self.w.store.connect() as db:
            self.assertEqual(db.execute("SELECT COUNT(*) FROM scores").fetchone()[0], 0)
            self.assertEqual(db.execute("SELECT COUNT(*) FROM exams").fetchone()[0], 0)

    def test_score_correction_recalculates_and_invalidates(self):
        self.scores()
        stats = self.w.facts.score_stats("demo_exam")
        a = self.w.artifacts.save("preparation", "针对零分备课", [stats["citation"]], text="练习")
        score = stats["questions"][0]["sources"][0]
        self.w.facts.correct("score", score["id"], 1, {"score": 6}, self.message("第一题应为六分"))
        self.assertEqual(self.w.facts.score_stats("demo_exam")["questions"][0]["mean_score"], "7.00")
        self.assertTrue(self.w.artifacts.read(a["id"])["stale"])

    def test_leases_fence_old_workers_and_only_saved_artifact_completes(self):
        lesson = self.w.store.one("lessons", "demo_l1")
        j = self.w.jobs.enqueue("review", str(lesson["revision"]), lesson_id="demo_l1")
        self.assertEqual(self.w.jobs.enqueue("review", str(lesson["revision"]), lesson_id="demo_l1")["id"], j["id"])
        old = self.w.jobs.claim(j["id"], "old")
        with self.w.store.transaction() as db:
            db.execute("UPDATE jobs SET lease_until=? WHERE id=?", (time.time() - 1, j["id"]))
        new = self.w.jobs.claim(j["id"], "new")
        with self.assertRaises(WorkbenchError):
            self.w.jobs.heartbeat(j["id"], "old", old["fence"])
        a = self.w.artifacts.save("brief", "实际文件", [self.ref], text="复盘")
        with self.assertRaises(WorkbenchError):
            self.w.jobs.complete(j["id"], "old", old["fence"], a["id"])
        self.assertEqual(self.w.jobs.complete(j["id"], "new", new["fence"], a["id"])["state"], "completed")

    def test_asr_failure_no_blind_resubmission(self):
        asset = self.w.store.ingest(self.path("lesson1.json"), "transcript")
        job = self.w.jobs.enqueue("audio", "asr-v1", asset["id"], "demo_l1")
        with patch.object(self.w.speech, "health", return_value={"ok": True}), patch.object(self.w.speech, "call", side_effect=WorkbenchError("network lost")) as client:
            with self.assertRaises(WorkbenchError):
                self.w.speech.submit(job["id"])
            self.assertEqual(self.w.store.one("jobs", job["id"])["state"], "needs_attention")
            with self.assertRaises(WorkbenchError):
                self.w.speech.submit(job["id"])
            self.assertEqual(client.call_count, 1)

    def test_backup_restores_corrected_facts_and_pending_questions(self):
        e = self.event()
        self.w.facts.correct("event", e["id"], 1, {"student_id": "demo_s02"}, self.message())
        self.w.facts.question("这个错误是否重复？", "demo_l1", e["id"])
        backup = self.w.store.backup()
        dest = Path(self.temp.name) / "restore"
        Store.restore(Path(backup["path"]), dest)
        restored = Workbench(Config(root=dest))
        self.assertEqual(restored.query.search("", student_id="demo_s02")["total_matches"], 1)
        self.assertEqual(restored.query.questions()["total"], 1)
        with self.assertRaises(WorkbenchError):
            Store.restore(Path(backup["path"]), dest)

    def test_courseware_prepare_is_idempotent_and_stale_source_blocks(self):
        p = self.w.artifacts.save("preparation", "虚构备课", [self.ref], text="四页定义域练习")
        c = Courseware(self.w.store)
        self.assertEqual(c.prepare(p["id"])["job"]["id"], c.prepare(p["id"])["job"]["id"])
        self.w.facts.correct("segment", self.ref["id"], 1, {"text": "更正原话"}, self.message())
        with self.assertRaises(WorkbenchError):
            c.prepare(p["id"])

    def test_new_transcript_supersedes_old_evidence(self):
        seg = self.w.store.one("segments", self.ref["id"])
        transcript = self.w.store.one("transcripts", seg["transcript_id"])
        self.w.facts.transcript(transcript["asset_id"], "v2", [{"start": 0, "end": 8, "text": "第二版正确转写"}])
        with self.assertRaises(WorkbenchError):
            self.w.facts.evidence(self.ref)
        self.assertEqual(self.w.query.search("根号下大于")["total_matches"], 0)

    def test_native_hooks_bind_each_chat_and_block_raw_tools(self):
        class Context:
            def __init__(self): self.tools, self.hooks = {}, {}
            def register_tool(self, **kw): self.tools[kw["name"]] = kw["handler"]
            def register_hook(self, name, callback): self.hooks[name] = callback
            def register_skill(self, *a, **kw): pass
            def register_system_prompt_section(self, *a, **kw): pass
        ctx = Context()
        register_plugin(ctx, self.w)
        self.assertEqual(len(ctx.tools), 9)
        ctx.hooks["pre_llm_call"](session_id="a", task_id="ta", user_message="甲老师消息")
        ctx.hooks["pre_llm_call"](session_id="b", task_id="tb", user_message="乙老师消息")
        ma = json.loads(ctx.tools["teacher_context"]({"action": "overview"}, task_id="ta"))["result"]["current_message_id"]
        mb = json.loads(ctx.tools["teacher_context"]({"action": "overview"}, task_id="tb"))["result"]["current_message_id"]
        self.assertNotEqual(ma, mb)
        result = json.loads(ctx.tools["teacher_correct"]({"action": "apply", "target_kind": "lesson", "target_id": "demo_l1", "expected_revision": self.w.store.one("lessons", "demo_l1")["revision"], "changes": {"topic": "新课题"}}, task_id="missing"))
        self.assertFalse(result["ok"])
        self.assertEqual(ctx.hooks["pre_tool_call"](tool_name="terminal")["action"], "block")
        self.assertIsNone(ctx.hooks["pre_tool_call"](tool_name="teacher_query"))
        ctx.hooks["on_session_end"](session_id="b")
        missing=json.loads(ctx.tools["teacher_context"]({"action":"overview"},task_id="old_unknown_task"))
        self.assertIsNone(missing["result"]["current_message_id"])

    def test_individual_scores_available_and_use_current_correction(self):
        self.scores()
        hits = self.w.query.search("", student_id="demo_s02")["matches"]
        self.assertEqual({h["student_id"] for h in hits}, {"demo_s02"})
        self.assertEqual(len(hits), 2)
        q1 = next(h for h in hits if h["question_id"] == "q1")
        self.w.facts.correct("score", q1["citation"]["id"], 1, {"score": 9}, self.message("该生第一题为九分"))
        self.assertEqual(self.w.facts.score_stats("demo_exam", "demo_s02")["questions"][0]["mean_score"], "9.00")
        self.assertEqual(self.w.query.read("score", q1["citation"]["id"])["score"], "9.00")

    def test_range_delete_covers_files_artifacts_jobs_and_known_backups(self):
        from workbench.maintenance import Maintenance
        e = self.event()
        a = self.w.artifacts.save("brief", "范围删除测试", [e["citation"]], text="虚构复盘")
        j = self.w.jobs.enqueue("review", str(self.w.store.one("lessons", "demo_l1")["revision"]), lesson_id="demo_l1")
        backup = self.w.store.backup()
        ops = Maintenance(self.w.store)
        plan = ops.plan(["demo_l1"])
        with self.assertRaises(WorkbenchError): ops.delete(["demo_l1"], confirmation="wrong")
        ops.delete(["demo_l1"], confirmation=plan["confirmation"])
        self.assertEqual(self.w.query.coverage()["lesson_count"], 1)
        self.assertFalse(Path(backup["path"]).exists())
        self.assertFalse(Path(a["absolute_path"]).exists())
        for table, value in [("lessons","demo_l1"),("events",e["id"]),("jobs",j["id"])]:
            with self.assertRaises(WorkbenchError): self.w.store.one(table,value)
        self.assertGreater(self.w.query.search("定义域")["total_matches"], 0)

    def test_shared_audio_survives_range_deletion(self):
        from workbench.maintenance import Maintenance
        seg=self.w.store.one("segments",self.ref["id"])
        tr=self.w.store.one("transcripts",seg["transcript_id"])
        self.w.facts.link_asset("demo_l2",tr["asset_id"])
        ops=Maintenance(self.w.store)
        plan=ops.plan(["demo_l1"])
        self.assertNotIn(tr["asset_id"],plan["assets"])
        ops.delete(["demo_l1"],confirmation=plan["confirmation"])
        asset=self.w.store.one("assets",tr["asset_id"])
        self.assertTrue(self.w.store.config.stored_file(asset["path"]).exists())

    def test_brief_cannot_complete_courseware_job(self):
        p=self.w.artifacts.save("preparation","备课",[self.ref],text="教学建议")
        j=Courseware(self.w.store).prepare(p["id"])["job"]
        claim=self.w.jobs.claim(j["id"],"operator")
        a=self.w.artifacts.save("brief","文字报告",[self.ref],text="没有做课件")
        with self.assertRaises(WorkbenchError): self.w.jobs.complete(j["id"],claim["owner"],claim["fence"],a["id"])

    def test_imported_original_corruption_is_detected(self):
        asset=self.w.store.ingest(self.path("lesson1.json"),"transcript")
        original=self.w.store.config.stored_file(asset["path"])
        data=original.read_bytes()
        original.write_bytes(b'x'+data[1:])
        with self.assertRaises(WorkbenchError): self.w.store.ingest(self.path("lesson1.json"),"transcript")

    def test_export_preserves_structured_history(self):
        from workbench.maintenance import Maintenance
        e=self.event()
        self.w.facts.correct("event",e["id"],1,{"student_id":"demo_s02"},self.message())
        result=Maintenance(self.w.store).export()
        records=json.loads(Path(result["records"]).read_text(encoding="utf-8"))
        self.assertEqual(records["events"][0]["student_id"],"demo_s02")
        self.assertEqual(len(records["corrections"]),1)


if __name__ == "__main__":
    unittest.main()
