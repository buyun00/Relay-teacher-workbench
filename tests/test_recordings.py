"""Fictional workflow fixtures exercise actual persistence and native teacher APIs."""
import hashlib
import io
import json
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

from workbench.config import Config, WorkbenchError
from workbench.ingress import DesktopIngress
from workbench.native import register_plugin
from workbench.recordings import RecordingWorker, Recordings
from workbench.service import Workbench


class RecordingCase(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="fictional-recording-workflow-")
        self.w = Workbench(Config(root=Path(self.temp.name), workspace_id="fictional-demo",
                                  auto_process_recordings=True))
        self.ingress = DesktopIngress(self.w.store)
        self.calls = []
        self.pending = True
        self.worker = self.new_worker()

    def tearDown(self):
        self.temp.cleanup()

    def new_worker(self, analyzer=None):
        worker = RecordingWorker(self.w.store, analyzer=analyzer or self.save_reports)
        worker.workbench.speech.call = self.asr
        return worker

    def asr(self, action, *arguments, **kwargs):
        self.calls.append(action)
        if action == "health":
            return {"status": "ok"}
        if action == "submit":
            return {"id": "a" * 32}
        if action == "status":
            return {"state": "running" if self.pending else "completed"}
        return {"words": [{"start": 0, "end": 2, "text": "明确虚构的函数课堂片段", "speaker": None}]}

    def upload(self, name="fictional.wav", content=b"EXPLICITLY FICTIONAL AUDIO BYTES"):
        self.sha = hashlib.sha256(content).hexdigest()
        manifest = {"sha256": self.sha, "byte_length": len(content), "filename": name,
                    "workspace_id": "fictional-demo", "client_id": "fictional-client"}
        opened = self.ingress.open(manifest)
        if not opened["receipt"]:
            self.ingress.write(opened["upload_id"], 0, io.BytesIO(content), len(content))
        receipt = self.ingress.complete(opened["upload_id"])["receipt"]
        self.asset = receipt["asset_id"]
        return receipt

    def status(self):
        return self.ingress.statuses({"workspace_id": "fictional-demo", "sha256": [self.sha]})["items"][0]

    def sources(self, job):
        with self.w.store.connect() as db:
            row = db.execute("SELECT id,revision FROM segments WHERE transcript_id=?",
                             (json.loads(job["result"])["transcript_id"],)).fetchone()
        return [{"kind": "segment", "id": row["id"], "revision": row["revision"]}]

    def save_reports(self, binding, job, _claimed):
        current = self.w.store.one("recording_workflows", binding["id"])
        for kind, key in [("brief", "review_id"), ("preparation", "preparation_id")]:
            if not current[key]:
                self.w.invoke("teacher_artifact", {"action": "save", "kind": kind,
                    "title": "明确虚构的" + kind, "text": "这是虚构验证产物，不是教学结论。",
                    "sources": self.sources(job)}, {"recording_workflow": binding})

    def complete(self):
        self.upload()
        self.pending = False
        self.worker.run_once()

    def test_restart_dedup_one_asr_and_only_two_saved_reports_complete(self):
        receipt = self.upload()
        self.assertEqual(self.status()["state"], "queued")
        self.worker.run_once()
        self.assertEqual(self.status()["state"], "transcribing")
        self.upload("fictional-renamed.wav")
        self.worker = self.new_worker()
        self.pending = False
        self.worker.run_once()
        state = self.status()
        self.assertEqual(state["state"], "analyzed")
        self.assertTrue(state["workflow"]["complete"])
        self.assertEqual(self.calls.count("submit"), 1)
        self.assertFalse(self.worker.run_once())
        result = self.ingress.results(self.sha)
        self.assertEqual(result["asset_id"], receipt["asset_id"])
        self.assertEqual({r["kind"] for r in result["reports"]}, {"brief", "preparation"})
        self.assertTrue(all("虚构" in r["text"] for r in result["reports"]))
        with self.w.store.connect() as db:
            self.assertEqual(db.execute("SELECT count(*) FROM jobs").fetchone()[0], 1)
            self.assertEqual(db.execute("SELECT count(*) FROM recording_workflows").fetchone()[0], 1)
            self.assertEqual(db.execute("SELECT count(*) FROM lessons").fetchone()[0], 0)

    def test_chat_reply_without_persisted_reports_is_not_completion(self):
        self.worker = self.new_worker(lambda *_args: "done, fictional chat reply")
        self.complete()
        self.assertEqual(self.status()["state"], "needs_attention")
        self.assertFalse(self.status()["workflow"]["complete"])
        self.assertEqual(self.ingress.results(self.sha)["reports"], [])

    def test_unknown_submit_never_automatically_resubmits(self):
        self.upload()
        calls = []
        def uncertain(action, *args, **kwargs):
            calls.append(action)
            if action == "submit":
                raise WorkbenchError("fictional lost acknowledgement")
            return {"status": "ok"}
        self.worker.workbench.speech.call = uncertain
        self.worker.run_once()
        self.upload("fictional-renamed.wav")
        self.worker = self.new_worker()
        self.assertFalse(self.worker.run_once())
        self.assertEqual(calls.count("submit"), 1)
        self.assertEqual(self.status()["state"], "needs_attention")

    def test_correction_invalidates_completion_and_old_citation(self):
        self.complete()
        row = self.w.store.one("recording_workflows", "recording_" + self.sha)
        job = self.w.store.one("jobs", row["audio_job_id"])
        ref = self.sources(job)[0]
        message = self.w.facts.message("教师更正虚构片段", "fictional-correction")["id"]
        self.w.facts.correct("segment", ref["id"], ref["revision"], {"text": "更正后的虚构文字"}, message)
        self.assertEqual(self.status()["state"], "stale")
        self.assertFalse(self.status()["workflow"]["complete"])
        with self.assertRaises(WorkbenchError):
            self.w.artifacts.save("brief", "旧版本虚构产物", [ref], text="虚构")
        self.assertEqual(self.calls.count("submit"), 1)

    def test_other_recording_and_expired_owner_cannot_attach(self):
        self.upload()
        self.worker.run_once()
        row = self.w.store.one("recording_workflows", "recording_" + self.sha)
        self.pending = False
        self.worker.workbench.speech.poll(row["audio_job_id"])
        other = self.w.store.root / "inbox" / "fictional-other.wav"
        other.write_bytes(b"EXPLICITLY FICTIONAL OTHER RECORDING")
        asset = self.w.store.ingest(str(other), "audio")
        self.w.facts.transcript(asset["id"], "fictional-v1", [{"start": 0, "end": 1, "text": "虚构其他录音"}])
        with self.w.store.connect() as db:
            segment = db.execute("SELECT s.id FROM segments s JOIN transcripts t ON t.id=s.transcript_id WHERE t.asset_id=?", (asset["id"],)).fetchone()[0]
        binding = Recordings(self.w.store).claim(row["id"], "fictional-owner")
        with self.assertRaises(WorkbenchError):
            self.w.artifacts.save("brief", "虚构其他录音", [{"kind": "segment", "id": segment, "revision": 1}],
                                  text="虚构", workflow=binding)
        self.pending = False
        Recordings(self.w.store).update(binding, lease_until=0)
        self.worker.run_once()
        with self.assertRaises(WorkbenchError):
            Recordings(self.w.store).update(binding, state="completed")

    def test_interrupted_analysis_reuses_transcript_and_partial_report(self):
        def interrupted(binding, job, _claimed):
            self.w.invoke("teacher_artifact", {"action": "save", "kind": "brief", "title": "虚构部分复盘",
                "text": "虚构", "sources": self.sources(job)}, {"recording_workflow": binding})
            self.worker.stopped.set()
            raise WorkbenchError("fictional interruption")
        self.worker = self.new_worker(interrupted)
        self.complete()
        self.assertEqual(self.status()["state"], "queued")
        self.worker = self.new_worker()
        self.worker.run_once()
        self.assertTrue(self.status()["workflow"]["complete"])
        self.assertEqual(self.calls.count("submit"), 1)
        with self.w.store.connect() as db:
            self.assertEqual(db.execute("SELECT count(*) FROM artifacts").fetchone()[0], 2)

    def test_native_hook_binds_workflow_to_real_artifact_handler(self):
        self.upload()
        self.pending = False
        def native(binding, job, _claimed):
            class Context:
                tools = {}
                hooks = {}
                def register_tool(self, **kw): self.tools[kw["name"]] = kw["handler"]
                def register_hook(self, name, fn): self.hooks[name] = fn
                def register_skill(self, *args, **kwargs): pass
                def register_system_prompt_section(self, *args, **kwargs): pass
            ctx = Context()
            register_plugin(ctx, self.w)
            with patch.dict("os.environ", {"HERMES_RECORDING_WORKFLOW": json.dumps(binding)}):
                ctx.hooks["pre_llm_call"](session_id="fictional-native", user_message="处理虚构上传")
            for kind in ("brief", "preparation"):
                result = ctx.tools["teacher_artifact"]({"action": "save", "kind": kind, "title": "虚构原生工具",
                    "text": "虚构原生工具产物", "sources": self.sources(job)}, session_id="fictional-native")
                self.assertTrue(json.loads(result)["ok"], result)
        self.worker = self.new_worker(native)
        self.worker.run_once()
        self.assertTrue(self.status()["workflow"]["complete"])

    def test_delete_scope_removes_workflow_and_receipt_without_resurrection(self):
        from workbench.maintenance import Maintenance
        self.complete()
        self.w.facts.lesson("fictional-delete", "明确虚构的删除课次")
        self.w.invoke("teacher_import", {"action": "link", "lesson_id": "fictional-delete", "asset_id": self.asset})
        ops = Maintenance(self.w.store)
        plan = ops.plan(["fictional-delete"])
        self.assertEqual(plan["recording_workflows"], ["recording_" + self.sha])
        ops.delete(["fictional-delete"], confirmation=plan["confirmation"])
        with self.w.store.connect() as db:
            self.assertEqual(db.execute("SELECT count(*) FROM recording_workflows").fetchone()[0], 0)
            self.assertEqual(db.execute("SELECT count(*) FROM desktop_uploads").fetchone()[0], 0)
            self.assertEqual(db.execute("PRAGMA foreign_key_check").fetchall(), [])

    def test_backup_restore_preserves_completed_results_and_pauses_external_work(self):
        from workbench.storage import Store
        self.complete()
        other = self.upload("fictional-pending.wav", b"EXPLICITLY FICTIONAL SECOND PENDING AUDIO")
        backup = self.w.store.backup()
        dest = Path(self.temp.name) / "restored-fictional"
        Store.restore(Path(backup["path"]), dest)
        restored = Workbench(Config(root=dest, workspace_id="fictional-demo"))
        with restored.store.connect() as db:
            rows = db.execute("SELECT state FROM recording_workflows ORDER BY state").fetchall()
        self.assertEqual([r[0] for r in rows], ["completed", "needs_attention"])

    def test_shared_recording_scope_deletion_pauses_workflow_without_resubmitting(self):
        from workbench.maintenance import Maintenance
        self.upload()
        for lid in ("fictional-remove", "fictional-keep"):
            self.w.facts.lesson(lid, "明确虚构的共享录音课次")
            self.w.invoke("teacher_import", {"action": "link", "lesson_id": lid, "asset_id": self.asset})
        self.w.jobs.enqueue("audio", "asr-v1", asset_id=self.asset, lesson_id="fictional-remove")
        self.pending = False
        self.worker.run_once()
        ops = Maintenance(self.w.store)
        plan = ops.plan(["fictional-remove"])
        self.assertEqual(plan["affected_recording_workflows"], ["recording_" + self.sha])
        ops.delete(["fictional-remove"], confirmation=plan["confirmation"])
        self.assertEqual(self.status()["state"], "needs_attention")
        self.assertFalse(self.worker.run_once())
        self.assertEqual(self.calls.count("submit"), 1)
        self.assertTrue(self.w.store.config.stored_file(self.w.store.one("assets", self.asset)["path"]).is_file())


if __name__ == "__main__":
    unittest.main()
