"""Recording receiver with optional durable orchestration of existing teacher tools."""
from __future__ import annotations

import argparse
import hashlib
import hmac
import json
import os
import time
import re
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path, PureWindowsPath
from urllib.parse import parse_qs, urlsplit

from .artifacts import Artifacts
from .config import Config, WorkbenchError
from .chats import Chats, ChatWorker
from .storage import Store, atomic_write, encode, now
from .recordings import Recordings, RecordingWorker


class ProtocolError(ValueError):
    def __init__(self, message, status=400):
        super().__init__(message)
        self.status = status


class DesktopIngress:
    def __init__(self, store: Store):
        self.store = store
        self.recordings = Recordings(store)
        self.locks: dict[str, threading.Lock] = {}
        self.lock = threading.Lock()
        self.incoming = store.root / "temporary" / "desktop-incoming"
        self.incoming.mkdir(parents=True, exist_ok=True)
        with store.connect() as db:
            db.execute("""CREATE TABLE IF NOT EXISTS desktop_uploads (
                upload_id TEXT PRIMARY KEY, sha256 TEXT NOT NULL UNIQUE, byte_length INTEGER NOT NULL,
                manifest TEXT NOT NULL, offset INTEGER NOT NULL DEFAULT 0,
                receipt TEXT, created_at TEXT NOT NULL
            )""")

    def upload_lock(self, upload_id):
        with self.lock:
            return self.locks.setdefault(upload_id, threading.Lock())

    def row(self, upload_id):
        if not re.fullmatch(r"up_[0-9a-f]{64}", upload_id):
            raise ProtocolError("Invalid upload ID", 404)
        with self.store.connect() as db:
            row = db.execute("SELECT * FROM desktop_uploads WHERE upload_id=?", (upload_id,)).fetchone()
        if not row:
            raise ProtocolError("Upload not found", 404)
        return dict(row)

    def path(self, row):
        manifest = json.loads(row["manifest"])
        suffix = Path(manifest["filename"]).suffix
        directory = self.incoming / row["upload_id"]
        directory.mkdir(exist_ok=True)
        return directory / ("recording" + suffix)

    def view(self, row):
        return {"upload_id": row["upload_id"], "offset": row["offset"],
                "workspace_id": self.store.config.workspace_id,
                "receipt": json.loads(row["receipt"]) if row["receipt"] else None}

    def _receipt(self, db, row, asset):
        if asset["sha256"] != row["sha256"] or asset["byte_length"] != row["byte_length"]:
            raise ProtocolError("Content identity mismatch", 422)
        receipt = {"upload_id": row["upload_id"], "sha256": asset["sha256"],
                   "byte_length": asset["byte_length"], "asset_id": asset["id"],
                   "received_at": asset["received_at"], "workspace_id": self.store.config.workspace_id}
        db.execute("UPDATE desktop_uploads SET receipt=?,offset=? WHERE upload_id=?",
                   (encode(receipt), row["byte_length"], row["upload_id"]))
        if self.store.config.auto_process_recordings:
            self.recordings.enqueue(asset["id"], db)
        self.store.audit(db, "desktop_received", asset["id"], {"upload_id": row["upload_id"]})

    def open(self, manifest):
        sha = manifest.get("sha256", "")
        size = manifest.get("byte_length")
        if not isinstance(sha, str) or not re.fullmatch(r"[0-9a-f]{64}", sha):
            raise ProtocolError("Invalid SHA-256")
        if isinstance(size, bool) or not isinstance(size, int) or size <= 0:
            raise ProtocolError("Invalid byte length")
        if manifest.get("workspace_id") != self.store.config.workspace_id:
            raise ProtocolError("Workspace mismatch", 409)
        filename = manifest.get("filename")
        if not isinstance(filename, str) or not filename or "\0" in filename:
            raise ProtocolError("Invalid filename")
        # The supplied name is metadata, never an on-disk path.
        manifest = {**manifest, "filename": Path(PureWindowsPath(filename).name).name}
        upload_id = "up_" + sha
        with self.upload_lock(upload_id), self.store.transaction() as db:
            db.execute("INSERT OR IGNORE INTO desktop_uploads(upload_id,sha256,byte_length,manifest,created_at) VALUES(?,?,?,?,?)",
                       (upload_id, sha, size, encode(manifest), now()))
            row = dict(db.execute("SELECT * FROM desktop_uploads WHERE upload_id=?", (upload_id,)).fetchone())
            if row["byte_length"] != size:
                raise ProtocolError("Content size mismatch", 422)
            if not row["receipt"]:
                asset = db.execute("SELECT * FROM assets WHERE sha256=?", (sha,)).fetchone()
                if asset:
                    self._receipt(db, row, asset)
                    row = dict(db.execute("SELECT * FROM desktop_uploads WHERE upload_id=?", (upload_id,)).fetchone())
        return self.view(row)

    def write(self, upload_id, offset, stream, length):
        with self.upload_lock(upload_id):
            row = self.row(upload_id)
            if row["receipt"]:
                # Consume the request body if a retry raced with finalization.
                remaining = length
                while remaining:
                    chunk = stream.read(min(1024 * 1024, remaining))
                    if not chunk:
                        raise ProtocolError("Incomplete chunk", 409)
                    remaining -= len(chunk)
                return self.view(row)
            if offset != row["offset"] or length <= 0 or offset + length > row["byte_length"]:
                raise ProtocolError("Offset mismatch", 409)
            target = self.path(row)
            if row["offset"] and (not target.exists() or target.stat().st_size < row["offset"]):
                with self.store.transaction() as db:
                    db.execute("UPDATE desktop_uploads SET offset=0 WHERE upload_id=?", (upload_id,))
                raise ProtocolError("Partial file lost; restart transfer", 409)
            with target.open("r+b" if target.exists() else "w+b") as out:
                # A crash can leave bytes after the last committed offset.
                out.truncate(offset)
                out.seek(offset)
                remaining = length
                while remaining:
                    chunk = stream.read(min(1024 * 1024, remaining))
                    if not chunk:
                        raise ProtocolError("Incomplete chunk", 409)
                    out.write(chunk)
                    remaining -= len(chunk)
                out.flush()
                os.fsync(out.fileno())
            if os.name != "nt":
                fd = os.open(target.parent, os.O_RDONLY)
                try:
                    os.fsync(fd)
                finally:
                    os.close(fd)
            with self.store.transaction() as db:
                db.execute("UPDATE desktop_uploads SET offset=? WHERE upload_id=?", (offset + length, upload_id))
            return self.view(self.row(upload_id))

    def complete(self, upload_id):
        with self.upload_lock(upload_id):
            row = self.row(upload_id)
            if row["receipt"]:
                return self.view(row)
            if row["offset"] != row["byte_length"]:
                raise ProtocolError("Transfer is incomplete", 409)
            target = self.path(row)
            digest = hashlib.sha256()
            with target.open("rb") as stream:
                while chunk := stream.read(1024 * 1024):
                    digest.update(chunk)
            # This validates new transport bytes, never rechecks saved originals.
            if target.stat().st_size != row["byte_length"] or digest.hexdigest() != row["sha256"]:
                with self.store.transaction() as db:
                    db.execute("UPDATE desktop_uploads SET offset=0 WHERE upload_id=?", (upload_id,))
                raise ProtocolError("Transfer checksum mismatch; restart transfer", 422)
            manifest = json.loads(row["manifest"])
            asset = self.store.ingest(str(target), "audio", {"origin": "desktop", "upload": manifest})
            with self.store.transaction() as db:
                if not asset["duplicate"]:
                    db.execute("UPDATE assets SET filename=? WHERE id=?", (manifest["filename"], asset["id"]))
                self._receipt(db, row, asset)
            target.unlink(missing_ok=True)
            return self.view(self.row(upload_id))

    def statuses(self, payload):
        if payload.get("workspace_id") != self.store.config.workspace_id:
            raise ProtocolError("Workspace mismatch", 409)
        digests = payload.get("sha256")
        if not isinstance(digests, list) or any(not isinstance(v, str) or not re.fullmatch(r"[0-9a-f]{64}", v) for v in digests):
            raise ProtocolError("Invalid status query")
        items = []
        with self.store.connect() as db:
            for sha in digests:
                asset = db.execute("SELECT * FROM assets WHERE sha256=?", (sha,)).fetchone()
                if not asset:
                    items.append({"sha256": sha, "state": "unknown"})
                    continue
                lessons = [r[0] for r in db.execute("SELECT DISTINCT lesson_id FROM lesson_assets WHERE asset_id=?", (asset["id"],))]
                transcripts = [r[0] for r in db.execute("SELECT id FROM transcripts WHERE asset_id=?", (asset["id"],))]
                jobs = [dict(r) for r in db.execute("SELECT id,kind,state,result,error,lesson_id,input_version FROM jobs WHERE asset_id=? OR lesson_id IN (SELECT lesson_id FROM lesson_assets WHERE asset_id=?)", (asset["id"], asset["id"]))]
                reports = []
                segment_ids = [r[0] for r in db.execute("SELECT s.id FROM segments s JOIN transcripts t ON t.id=s.transcript_id WHERE t.asset_id=?", (asset["id"],))]
                relevant = {asset["id"], *lessons, *transcripts, *segment_ids}
                for event in db.execute("SELECT id,sources FROM events WHERE lesson_id IN (SELECT lesson_id FROM lesson_assets WHERE asset_id=?)", (asset["id"],)):
                    if any(ref.get("id") in relevant for ref in json.loads(event["sources"])):
                        relevant.add(event["id"])
                for report in db.execute("SELECT id,sources FROM artifacts WHERE kind='brief'"):
                    if any(ref.get("id") in relevant for ref in json.loads(report["sources"])):
                        reports.append(report["id"])
                current_reports, stale_reports = [], []
                for report_id in reports:
                    report = Artifacts(self.store).read(report_id)
                    (stale_reports if report["stale"] else current_reports).append(report_id)
                if current_reports:
                    state = "analyzed"
                elif stale_reports:
                    state = "stale"
                elif any(j["state"] in {"needs_attention", "failed"} for j in jobs):
                    state = "needs_attention"
                elif any(j["kind"] == "review" and j["state"] in {"queued", "running"} for j in jobs):
                    state = "analyzing"
                elif transcripts:
                    state = "transcribed"
                elif any(j["kind"] == "audio" and j["state"] in {"running", "waiting_external"} for j in jobs):
                    state = "transcribing"
                elif jobs:
                    state = "queued"
                else:
                    state = "received" if lessons else "awaiting_lesson"
                workflow = self.recordings.view(asset["id"])
                if workflow:
                    state = workflow["state"]
                items.append({"sha256": sha, "asset_id": asset["id"], "state": state, "lesson_ids": lessons,
                              "transcript_ids": transcripts, "artifact_ids": current_reports, "stale_artifact_ids": stale_reports,
                              "jobs": jobs, "workflow": workflow})
        return {"workspace_id": self.store.config.workspace_id, "checked_at": now(), "items": items}

    def results(self, sha):
        with self.store.connect() as db:
            asset = db.execute("SELECT id FROM assets WHERE sha256=?", (sha,)).fetchone()
        if not asset:
            raise ProtocolError("Recording not found", 404)
        result = self.recordings.results(asset["id"])
        result["reports"] = [{key: report[key] for key in
            ("id", "kind", "title", "text", "sources", "stale", "created_at", "warning")}
            for report in result["reports"]]
        return {**result, "sha256": sha, "asset_id": asset["id"],
                "workspace_id": self.store.config.workspace_id}


class IngressServer(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, address, ingress: DesktopIngress, token: str = ""):
        self.ingress, self.token = ingress, token
        self.chats = Chats(ingress.store)
        self.stream_stop = threading.Event()
        super().__init__(address, Handler)

    def server_close(self):
        self.stream_stop.set()
        super().server_close()


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass  # No recording names, credentials or business data in access logs.

    def reply(self, status, body):
        payload = encode(body).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(payload)

    def length(self):
        try:
            value = int(self.headers.get("Content-Length", "0"))
        except ValueError as exc:
            raise ProtocolError("Invalid content length") from exc
        if value < 0:
            raise ProtocolError("Invalid content length")
        return value

    def payload(self):
        try:
            value = json.loads(self.rfile.read(self.length()))
        except (ValueError, UnicodeDecodeError) as exc:
            raise ProtocolError("Invalid JSON") from exc
        if not isinstance(value, dict):
            raise ProtocolError("Expected JSON object")
        return value

    def stream_chat(self, chat_id, after):
        chats = self.server.chats
        chats.chat(chat_id)
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Accel-Buffering", "no")
        self.end_headers()
        deadline = time.monotonic() + 40
        try:
            while time.monotonic() < deadline and not self.server.stream_stop.is_set():
                events = chats.events(chat_id, after)
                for event in events:
                    self.wfile.write(("id: %s\ndata: %s\n\n" % (event["seq"], encode(event))).encode("utf-8"))
                    after = event["seq"]
                if not events:
                    self.wfile.write(b": keepalive\n\n")
                self.wfile.flush()
                self.server.stream_stop.wait(.15 if events else .7)
        except (ConnectionError, TimeoutError):
            pass  # Closing the desktop detaches the stream, never cancels the native turn.

    def chat_payload(self):
        payload = self.payload()
        if payload.get("workspace_id") != self.server.ingress.store.config.workspace_id:
            raise ProtocolError("Workspace mismatch", 409)
        return payload

    def dispatch(self):
        try:
            self.connection.settimeout(60)
            if self.server.token and not hmac.compare_digest(self.headers.get("Authorization", ""), "Bearer " + self.server.token):
                raise ProtocolError("Unauthorized", 401)
            parsed = urlsplit(self.path)
            ingress = self.server.ingress
            if self.command == "GET" and parsed.path == "/v1/health":
                result = {"protocol": 1, "workspace_id": ingress.store.config.workspace_id, "status": "ok"}
            elif self.command == "POST" and parsed.path == "/v1/uploads":
                result = ingress.open(self.payload())
            elif self.command == "POST" and parsed.path == "/v1/status":
                result = ingress.statuses(self.payload())
            elif self.command == "GET" and parsed.path == "/v1/chat-models":
                result = self.server.chats.models()
            elif parsed.path == "/v1/chats" and self.command in {"GET", "POST"}:
                result = self.server.chats.list() if self.command == "GET" else self.server.chats.create(self.chat_payload())
            elif match := re.fullmatch(r"/v1/chats/([A-Za-z0-9_-]+)(?:/(turns|model|cancel|events))?", parsed.path):
                chat_id, action = match.groups()
                chats = self.server.chats
                if self.command == "GET" and not action:
                    result = chats.read(chat_id)
                elif self.command == "POST" and action == "turns":
                    result = chats.submit(chat_id, self.chat_payload())
                elif self.command == "POST" and action == "model":
                    result = chats.select_model(chat_id, self.chat_payload())
                elif self.command == "POST" and action == "cancel":
                    self.chat_payload()
                    result = chats.cancel(chat_id)
                elif self.command == "GET" and action == "events":
                    try:
                        after = int(parse_qs(parsed.query).get("after", ["0"])[0])
                    except ValueError as exc:
                        raise ProtocolError("Invalid event cursor") from exc
                    self.stream_chat(chat_id, after)
                    return
                else:
                    raise ProtocolError("Not found", 404)
            elif self.command == "GET" and (match := re.fullmatch(r"/v1/recordings/([0-9a-f]{64})/results", parsed.path)):
                result = ingress.results(match.group(1))
            elif match := re.fullmatch(r"/v1/uploads/(up_[a-f0-9]{64})(/complete)?", parsed.path):
                upload_id, complete = match.groups()
                if self.command == "POST" and complete:
                    result = ingress.complete(upload_id)
                elif self.command == "GET" and not complete:
                    result = ingress.view(ingress.row(upload_id))
                elif self.command == "PUT" and not complete:
                    try:
                        offset = int(parse_qs(parsed.query).get("offset", [""])[0])
                    except ValueError as exc:
                        raise ProtocolError("Invalid offset") from exc
                    result = ingress.write(upload_id, offset, self.rfile, self.length())
                else:
                    raise ProtocolError("Not found", 404)
            else:
                raise ProtocolError("Not found", 404)
            self.reply(200, result)
        except ProtocolError as exc:
            self.reply(exc.status, {"error": str(exc)})
        except WorkbenchError as exc:
            self.reply(409, {"error": str(exc)})
        except (OSError, ValueError, KeyError):
            self.reply(500, {"error": "Persistence failed; file not acknowledged"})

    do_GET = do_POST = do_PUT = dispatch


def main():
    parser = argparse.ArgumentParser(description="Desktop recording receiver and existing teacher workflow")
    parser.add_argument("--root", type=Path)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8766)
    parser.add_argument("--token-env", default="HERMES_UPLOADER_TOKEN")
    parser.add_argument("--auto-process", action="store_true", help="Use the configured native teacher profile after receipt")
    parser.add_argument("--pid-file", type=Path)
    args = parser.parse_args()
    config = Config.load(root=args.root)
    if args.auto_process:
        from dataclasses import replace
        config = replace(config, auto_process_recordings=True)
    server = IngressServer((args.host, args.port), DesktopIngress(Store(config)), os.environ.get(args.token_env, ""))
    print(encode({"listen": server.server_address, "workspace_id": config.workspace_id, "protocol": 1}), flush=True)
    worker = RecordingWorker(server.ingress.store) if config.auto_process_recordings else None
    chat_worker = ChatWorker(server.chats) if config.auto_process_recordings else None
    if worker:
        worker.start()
    if chat_worker:
        chat_worker.start()
    import signal
    def stop_signal(*_args):
        raise KeyboardInterrupt
    signal.signal(signal.SIGTERM, stop_signal)
    if args.pid_file:
        atomic_write(args.pid_file, str(os.getpid()).encode())
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        if chat_worker:
            chat_worker.stop()
        if worker:
            worker.stop()
        server.server_close()
        if args.pid_file:
            args.pid_file.unlink(missing_ok=True)


if __name__ == "__main__":
    main()
