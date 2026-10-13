"""Fictional chat files: transport, immutable message identity and backup invariants."""
import hashlib
import io
import json
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from pathlib import Path
from unittest.mock import patch

from workbench.attachments import ChatAttachments
from workbench.chats import Chats
from workbench.config import Config, WorkbenchError
from workbench.ingress import DesktopIngress, IngressServer
from workbench.storage import Store


class AttachmentTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.store = Store(Config(Path(self.temp.name), "fictional-chat-files"))
        self.chats = Chats(self.store)
        self.chats.create({"id": "fictional-a"})
        self.chats.create({"id": "fictional-b"})
        self.files = ChatAttachments(self.chats)

    def tearDown(self):
        self.temp.cleanup()

    def manifest(self, aid="fictional-attachment", data=b"FICTIONAL FILE 7319", name="fictional.txt"):
        return {"id": aid, "filename": name, "mime": "text/plain", "byte_length": len(data),
                "sha256": hashlib.sha256(data).hexdigest(), "workspace_id": "fictional-chat-files"}

    def add(self, aid="fictional-attachment", data=b"FICTIONAL FILE 7319", name="fictional.txt"):
        self.files.open("fictional-a", self.manifest(aid, data, name))
        if data:
            self.files.write("fictional-a", aid, 0, io.BytesIO(data), len(data))
        return self.files.complete("fictional-a", aid)

    def test_resume_truncates_uncommitted_bytes_and_durable_receipt_never_rehashes(self):
        data = b"FICTIONAL BYTES 123456789"
        aid = "fictional-attachment"
        self.files.open("fictional-a", self.manifest(data=data))
        self.files.write("fictional-a", aid, 0, io.BytesIO(data[:8]), 8)
        with self.files.partial(self.files.row("fictional-a", aid)).open("ab") as out:
            out.write(b"UNCOMMITTED")
        self.files = ChatAttachments(Chats(Store(self.store.config)))
        self.assertEqual(self.files.open("fictional-a", self.manifest(data=data))["offset"], 8)
        self.files.write("fictional-a", aid, 8, io.BytesIO(data[8:]), len(data) - 8)
        first = self.files.complete("fictional-a", aid)
        with patch("workbench.attachments.hashlib.sha256", side_effect=AssertionError("must not rehash saved originals")):
            self.assertEqual(self.files.complete("fictional-a", aid), first)
        row, target = self.files.content("fictional-a", aid)
        self.assertEqual(target.read_bytes(), data)
        self.assertEqual(first["bytes"], len(data))
        with self.assertRaises(WorkbenchError):
            self.files.open("fictional-b", self.manifest(data=data))

    def test_attachment_only_turn_is_immutable_ordered_scoped_and_survives_backup(self):
        self.add()
        self.add("fictional-second", b"", "fictional.empty")
        ids = ["fictional-second", "fictional-attachment"]
        payload = {"id": "fictional-turn", "content": "", "attachments": ids}
        first = self.chats.submit("fictional-a", payload)
        self.assertEqual([a["id"] for a in first["attachments"]], ids)
        self.assertEqual(self.chats.submit("fictional-a", payload), first)
        with self.assertRaises(WorkbenchError):
            self.chats.submit("fictional-a", {**payload, "attachments": ids[::-1]})
        with self.assertRaises(WorkbenchError):
            self.chats.submit("fictional-b", {**payload, "id": "fictional-cross-chat"})
        self.chats.archive("fictional-a", {"archived": True})
        self.assertEqual(self.chats.submit("fictional-a", payload), first)
        self.chats.finish("fictional-turn", "completed", "FICTIONAL ANSWER")
        backup = self.store.backup()
        destination = self.store.root / "restored"
        Store.restore(Path(backup["path"]), destination)
        restored = Chats(Store(Config(destination, "fictional-chat-files")))
        view = restored.read("fictional-a")
        self.assertEqual(view["chat"]["hermes_session_id"], "teacher-desktop-fictional-a")
        self.assertEqual([a["id"] for a in view["turns"][0]["attachments"]], ids)
        files = ChatAttachments(restored)
        self.assertEqual(files.content("fictional-a", ids[1])[1].read_bytes(), b"FICTIONAL FILE 7319")
        with self.store.connect() as db:
            self.assertEqual(db.execute("SELECT COUNT(*) FROM assets").fetchone()[0], 0)
            self.assertEqual(db.execute("SELECT COUNT(*) FROM recording_workflows").fetchone()[0], 0)

    def test_incomplete_files_are_not_accepted_and_checksum_failure_can_be_retried(self):
        data = b"FICTIONAL ORIGINAL"
        self.files.open("fictional-a", self.manifest(data=data))
        with self.assertRaises(WorkbenchError):
            self.chats.submit("fictional-a", {"id": "fictional-turn", "content": "", "attachments": ["fictional-attachment"]})
        bad = b"X" * len(data)
        self.files.write("fictional-a", "fictional-attachment", 0, io.BytesIO(bad), len(bad))
        with self.assertRaises(WorkbenchError):
            self.files.complete("fictional-a", "fictional-attachment")
        self.assertEqual(self.files.open("fictional-a", self.manifest(data=data))["offset"], 0)
        self.files.write("fictional-a", "fictional-attachment", 0, io.BytesIO(data), len(data))
        self.assertTrue(self.files.complete("fictional-a", "fictional-attachment")["received_at"])

    def test_http_file_and_image_upload_download_requires_receipt_and_preserves_bytes(self):
        server = IngressServer(("127.0.0.1", 0), DesktopIngress(self.store), "FICTIONAL-TOKEN")
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        endpoint = "http://127.0.0.1:" + str(server.server_port)
        data = b"FICTIONAL PDF CONTENT 4268"
        route = "/v1/chats/fictional-a/attachments"

        def request(path, body=None, method="POST", token="FICTIONAL-TOKEN"):
            raw = body if isinstance(body, bytes) else json.dumps(body).encode() if body is not None else None
            req = urllib.request.Request(endpoint + path, data=raw, method=method, headers={"Authorization": "Bearer " + token})
            with urllib.request.urlopen(req) as response:
                return response.read()

        try:
            with self.assertRaises(urllib.error.HTTPError) as error:
                request(route, self.manifest(data=data), token="FICTIONAL-WRONG")
            self.assertEqual(error.exception.code, 401)
            error.exception.close()
            request(route, self.manifest(data=data, name="fictional.pdf"))
            request(route + "/fictional-attachment?offset=0", data, "PUT")
            with self.assertRaises(urllib.error.HTTPError) as incomplete:
                request(route + "/fictional-attachment/content", method="GET")
            incomplete.exception.close()
            receipt = json.loads(request(route + "/fictional-attachment/complete", {"workspace_id": "fictional-chat-files"}))
            self.assertTrue(receipt["received_at"])
            self.assertEqual(request(route + "/fictional-attachment/content", method="GET"), data)
            submitted = json.loads(request("/v1/chats/fictional-a/turns", {"id": "fictional-http-turn", "content": "",
                                   "attachments": [receipt["id"]], "workspace_id": "fictional-chat-files"}))
            self.assertEqual(submitted["attachments"][0]["filename"], "fictional.pdf")
        finally:
            server.shutdown(); server.server_close(); thread.join(2)


if __name__ == "__main__":
    unittest.main()
