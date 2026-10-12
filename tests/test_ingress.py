"""Synthetic transfer acceptance. No real recordings or ASR are used."""
import hashlib
import io
import json
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import patch
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from workbench.config import Config
from workbench.ingress import DesktopIngress, IngressServer, ProtocolError
from workbench.service import Workbench


class DesktopIngressCase(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="fictional-teacher-ingress-")
        self.w = Workbench(Config(root=Path(self.temp.name), workspace_id="fictional-demo"))
        self.receiver = DesktopIngress(self.w.store)
        self.data = b"EXPLICITLY FICTIONAL RECORDING FOR TRANSPORT TESTS; NOT REAL AUDIO"
        self.sha = hashlib.sha256(self.data).hexdigest()
        self.manifest = {"sha256": self.sha, "byte_length": len(self.data), "filename": "fictional-time.wav",
                         "workspace_id": "fictional-demo", "client_id": "fictional-client"}

    def tearDown(self):
        self.temp.cleanup()

    def upload(self):
        opened = self.receiver.open(self.manifest)
        self.receiver.write(opened["upload_id"], 0, io.BytesIO(self.data), len(self.data))
        return self.receiver.complete(opened["upload_id"])

    def status(self):
        return self.receiver.statuses({"workspace_id": "fictional-demo", "sha256": [self.sha]})["items"][0]

    def test_only_persisted_original_has_receipt_and_native_teacher_context_can_find_it(self):
        opened = self.receiver.open(self.manifest)
        self.assertIsNone(opened["receipt"])
        self.receiver.write(opened["upload_id"], 0, io.BytesIO(self.data[:10]), 10)
        with self.assertRaises(ProtocolError):
            self.receiver.complete(opened["upload_id"])
        self.receiver.write(opened["upload_id"], 10, io.BytesIO(self.data[10:]), len(self.data) - 10)
        receipt = self.receiver.complete(opened["upload_id"])["receipt"]
        asset = self.w.store.one("assets", receipt["asset_id"])
        self.assertEqual(self.w.store.config.stored_file(asset["path"]).read_bytes(), self.data)
        self.assertEqual(asset["filename"], self.manifest["filename"])
        self.assertEqual(receipt["workspace_id"], "fictional-demo")
        self.assertEqual(self.status()["state"], "awaiting_lesson")
        overview = self.w.invoke("teacher_context", {"action": "overview"})
        self.assertEqual(overview["pending_recordings"][0]["id"], asset["id"])
        with self.w.store.connect() as db:
            self.assertEqual(db.execute("SELECT COUNT(*) FROM jobs").fetchone()[0], 0)

    def test_server_restart_and_crash_tail_resume_from_committed_offset(self):
        opened = self.receiver.open(self.manifest)
        self.receiver.write(opened["upload_id"], 0, io.BytesIO(self.data[:11]), 11)
        target = self.receiver.path(self.receiver.row(opened["upload_id"]))
        with target.open("ab") as stream:
            stream.write(b"FICTIONAL CRASH TAIL NOT COMMITTED")
        fresh = DesktopIngress(self.w.store)
        self.assertEqual(fresh.open(self.manifest)["offset"], 11)
        fresh.write(opened["upload_id"], 11, io.BytesIO(self.data[11:]), len(self.data) - 11)
        self.assertEqual(target.read_bytes(), self.data)
        self.assertIsNotNone(fresh.complete(opened["upload_id"])["receipt"])

    def test_bad_transfer_checksum_is_not_ingested(self):
        opened = self.receiver.open(self.manifest)
        wrong = b"X" * len(self.data)
        self.receiver.write(opened["upload_id"], 0, io.BytesIO(wrong), len(wrong))
        with self.assertRaises(ProtocolError) as error:
            self.receiver.complete(opened["upload_id"])
        self.assertEqual(error.exception.status, 422)
        with self.w.store.connect() as db:
            self.assertEqual(db.execute("SELECT COUNT(*) FROM assets").fetchone()[0], 0)
        self.assertEqual(self.receiver.open(self.manifest)["offset"], 0)

    def test_lost_ack_repeated_complete_and_renamed_source_share_one_asset(self):
        result = self.upload()
        fresh = DesktopIngress(self.w.store)
        renamed = fresh.open({**self.manifest, "filename": "fictional-renamed.wav"})
        self.assertEqual(renamed["receipt"], result["receipt"])
        self.assertEqual(fresh.complete(renamed["upload_id"])["receipt"], result["receipt"])
        with self.w.store.connect() as db:
            self.assertEqual(db.execute("SELECT COUNT(*) FROM assets").fetchone()[0], 1)

    def test_commit_before_receipt_crash_recovers_without_reimport(self):
        opened = self.receiver.open(self.manifest)
        self.receiver.write(opened["upload_id"], 0, io.BytesIO(self.data), len(self.data))
        target = self.receiver.path(self.receiver.row(opened["upload_id"]))
        asset = self.w.store.ingest(str(target), "audio", {"origin": "fictional-desktop"})
        fresh = DesktopIngress(self.w.store)
        receipt = fresh.open(self.manifest)["receipt"]
        self.assertEqual(receipt["asset_id"], asset["id"])
        with self.w.store.connect() as db:
            self.assertEqual(db.execute("SELECT COUNT(*) FROM assets").fetchone()[0], 1)

    def test_status_reads_real_facts_and_current_report_versions_without_asr_or_model(self):
        result = self.upload()
        aid = result["receipt"]["asset_id"]
        self.w.invoke("teacher_import", {"action": "lesson", "lesson_id": "fictional_l1", "topic": "虚构课题"})
        self.w.invoke("teacher_import", {"action": "link", "lesson_id": "fictional_l1", "asset_id": aid})
        self.assertEqual(self.status()["state"], "received")
        self.w.invoke("teacher_job", {"action": "enqueue", "kind": "audio", "asset_id": aid,
                                      "lesson_id": "fictional_l1", "input_version": "asr-v1"})
        self.assertEqual(self.status()["state"], "queued")
        self.w.facts.transcript(aid, "fictional_v1", [{"start": 0, "end": 5, "text": "明确虚构的课堂片段", "speaker": "SPEAKER_00"}])
        self.assertEqual(self.status()["state"], "transcribed")
        lesson = self.w.store.one("lessons", "fictional_l1")
        with self.w.store.connect() as db:
            segment = db.execute("SELECT s.id,s.revision FROM segments s JOIN transcripts t ON t.id=s.transcript_id WHERE t.asset_id=?", (aid,)).fetchone()
        report = self.w.artifacts.save("brief", "虚构复盘", [
            {"kind": "lesson", "id": "fictional_l1", "revision": lesson["revision"]},
            {"kind": "segment", "id": segment["id"], "revision": segment["revision"]}], text="明确虚构的复盘报告")
        with patch.object(self.w.speech, "call", side_effect=AssertionError("Status must not call ASR")):
            self.assertEqual(self.status()["state"], "analyzed")
        msg = self.w.facts.message("更正虚构课题", "fictional-session")["id"]
        self.w.facts.correct("lesson", "fictional_l1", lesson["revision"], {"topic": "更正后的虚构课题"}, msg)
        status = self.status()
        self.assertEqual(status["state"], "stale")
        self.assertEqual(status["stale_artifact_ids"], [report["id"]])
        self.assertEqual(status["artifact_ids"], [])

    def test_http_health_upload_and_authenticated_metadata_status(self):
        server = IngressServer(("127.0.0.1", 0), self.receiver, "fictional-only-token")
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        endpoint = "http://127.0.0.1:" + str(server.server_port)

        def call(route, payload=None, token="fictional-only-token", method=None):
            data = json.dumps(payload).encode() if payload is not None else None
            request = Request(endpoint + route, data=data, method=method,
                              headers={"Authorization": "Bearer " + token, "Content-Type": "application/json"})
            with urlopen(request, timeout=5) as response:
                return json.load(response)
        try:
            self.assertEqual(call("/v1/health")["protocol"], 1)
            with self.assertRaises(HTTPError) as error:
                call("/v1/health", token="wrong-fictional-token")
            self.assertEqual(error.exception.code, 401)
            error.exception.close()
            opened = call("/v1/uploads", self.manifest)
            request = Request(endpoint + "/v1/uploads/" + opened["upload_id"] + "?offset=0", data=self.data, method="PUT",
                              headers={"Authorization": "Bearer fictional-only-token"})
            with urlopen(request, timeout=5) as response:
                self.assertEqual(json.load(response)["offset"], len(self.data))
            receipt = call("/v1/uploads/" + opened["upload_id"] + "/complete", method="POST")["receipt"]
            self.assertEqual(receipt["sha256"], self.sha)
            status = call("/v1/status", {"workspace_id": "fictional-demo", "sha256": [self.sha]})
            self.assertEqual(status["items"][0]["state"], "awaiting_lesson")
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=5)


    def test_http_chat_auth_workspace_idempotency_and_sse_replay(self):
        import threading
        from urllib.request import Request, urlopen
        from urllib.error import HTTPError
        server = IngressServer(("127.0.0.1", 0), self.receiver, "fictional-only-token")
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        endpoint = "http://127.0.0.1:" + str(server.server_port)
        def call(route, payload=None):
            headers = {"Authorization": "Bearer fictional-only-token"}
            if payload is not None:
                headers["Content-Type"] = "application/json"
            with urlopen(Request(endpoint + route, data=json.dumps(payload).encode() if payload is not None else None, headers=headers), timeout=5) as response:
                return json.load(response)
        try:
            with self.assertRaises(HTTPError) as wrong:
                call("/v1/chats", {"id": "fictional-http", "workspace_id": "fictional-wrong-space"})
            self.assertEqual(wrong.exception.code, 409)
            wrong.exception.close()
            self.assertEqual(call("/v1/chats")["chats"], [])
            with self.assertRaises(HTTPError) as auth:
                urlopen(endpoint + "/v1/chat-models", timeout=5)
            self.assertEqual(auth.exception.code, 401)
            auth.exception.close()
            view = call("/v1/chats", {"id": "fictional-http", "workspace_id": "fictional-demo"})
            self.assertEqual(view["chat"]["route_state"], "triage")
            body = {"id": "fictional-http-turn", "content": "虚构课堂消息", "workspace_id": "fictional-demo"}
            first = call("/v1/chats/fictional-http/turns", body)
            repeated = call("/v1/chats/fictional-http/turns", body)
            self.assertEqual(first["id"], repeated["id"])
            server.chats.delta(first["id"], "虚构增量输出")
            request = Request(endpoint + "/v1/chats/fictional-http/events?after=0", headers={"Authorization": "Bearer fictional-only-token"})
            with urlopen(request, timeout=5) as response:
                self.assertIn("text/event-stream", response.headers["Content-Type"])
                seen = []
                while len(seen) < 2:
                    line = response.readline().decode()
                    if line.startswith("data: "):
                        seen.append(json.loads(line[6:]))
                self.assertEqual(seen[0]["kind"], "turn")
                self.assertEqual(seen[1]["payload"]["text"], "虚构增量输出")
            stopped = call("/v1/chats/fictional-http/cancel", {"workspace_id": "fictional-demo"})
            self.assertEqual(stopped["turns"][0]["state"], "cancelled")
            self.assertEqual(stopped["turns"][0]["answer"], "虚构增量输出")
        finally:
            server.shutdown()
            server.server_close()
            thread.join(5)


if __name__ == "__main__":
    unittest.main()
