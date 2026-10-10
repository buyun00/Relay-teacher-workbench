from __future__ import annotations

import json
import subprocess
import wave

from .config import WorkbenchError
from .facts import Facts
from .jobs import Jobs
from .storage import Store, atomic_write, encode, identifier, now


class Speech:
    """Thin adapter to the installed client; no models, keys or alternate ASR engine."""

    def __init__(self, store: Store):
        self.store = store

    def call(self, *arguments, timeout=45):
        c = self.store.config
        if not c.speech_client or not c.speech_client.is_file() or not c.speech_url:
            raise WorkbenchError("未配置现有 ASR 客户端和地址")
        import sys
        process = subprocess.run([sys.executable, str(c.speech_client), "--url", c.speech_url, *map(str, arguments)],
                                 stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=timeout, encoding="utf-8")
        try:
            result = json.loads(process.stdout)
        except ValueError as exc:
            raise WorkbenchError("ASR 客户端未返回有效 JSON：" + process.stderr[-500:]) from exc
        if process.returncode and not (arguments[0] == "status" and result.get("state") == "failed"):
            raise WorkbenchError("ASR 客户端失败：" + process.stderr[-1000:])
        return result

    def health(self):
        return self.call("health", timeout=15)

    def import_audio(self, path: str, lesson_id: str) -> dict:
        source = self.store.config.input_file(path)
        if source.suffix.lower() not in {".wav", ".mp3", ".m4a", ".aac", ".flac", ".ogg", ".mp4", ".wma"}:
            raise WorkbenchError("音频扩展名不受支持")
        if source.suffix.lower() == ".wav":
            try:
                with wave.open(str(source)) as audio:
                    if audio.getnframes() <= 0:
                        raise WorkbenchError("录音没有音频帧")
            except (wave.Error, EOFError) as exc:
                raise WorkbenchError("WAV 文件不可读") from exc
        else:
            try:
                process = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "a:0", "-show_entries", "stream=codec_type", "-of", "json", str(source)], capture_output=True, text=True, timeout=20)
                if process.returncode or not json.loads(process.stdout).get("streams"):
                    raise WorkbenchError("资料没有可读音轨")
            except (OSError, ValueError) as exc:
                raise WorkbenchError("媒体校验工具不可用") from exc
        return self.store.ingest(path, "audio", {"origin": "teacher_import"},
                                 task={"kind": "audio", "lesson_id": lesson_id, "input_version": "asr-v1"})

    def submit(self, job_id: str, diarize=True, speakers=None) -> dict:
        if speakers is not None and (isinstance(speakers, bool) or not isinstance(speakers, int) or not 1 <= speakers <= 100):
            raise WorkbenchError("说话人数无效")
        row = self.store.one("jobs", job_id)
        if row["kind"] != "audio":
            raise WorkbenchError("不是录音任务")
        if row["external_id"]:
            return self.poll(job_id)
        if row["state"] != "queued":
            raise WorkbenchError("录音提交状态不明确，不能自动重复提交")
        self.health()
        claimed = Jobs(self.store).claim(job_id, identifier("asr"))
        if claimed["state"] != "running":
            return claimed
        asset = self.store.one("assets", row["asset_id"])
        arguments = ["submit", str(self.store.config.stored_file(asset["path"])), "--language", "Chinese"]
        if not diarize:
            arguments.append("--no-diarize")
        if speakers is not None:
            arguments += ["--speakers", str(speakers)]
        try:
            response = self.call(*arguments, timeout=120)
            external = response.get("id")
            if not isinstance(external, str) or len(external) != 32 or any(ch not in "0123456789abcdef" for ch in external):
                raise WorkbenchError("ASR 任务 ID 无效")
            with self.store.transaction() as db:
                current = self.store.one("jobs", job_id, db)
                Jobs.check_owner(current, claimed["owner"], claimed["fence"])
                db.execute("UPDATE jobs SET state='waiting_external',external_id=?,lease_until=NULL,updated_at=? WHERE id=?", (external, now(), job_id))
        except (WorkbenchError, OSError, subprocess.TimeoutExpired) as exc:
            with self.store.transaction() as db:
                db.execute("UPDATE jobs SET state='needs_attention',error=?,lease_until=NULL,updated_at=? WHERE id=? AND fence=?", ("ASR 提交结果不明确，核查外部任务后再处理：" + str(exc)[:1000], now(), job_id, claimed["fence"]))
            raise WorkbenchError("ASR 提交未确认，资料已保留，任务需要核查；不会自动重复提交") from exc
        return self.store.one("jobs", job_id)

    def poll(self, job_id: str) -> dict:
        row = self.store.one("jobs", job_id)
        if row["kind"] != "audio" or not row["external_id"]:
            raise WorkbenchError("录音没有已确认的 ASR 任务 ID")
        if row["state"] in {"ready", "completed", "failed"}:
            return row
        response = self.call("status", row["external_id"])
        if response.get("state") == "failed":
            with self.store.transaction() as db:
                db.execute("UPDATE jobs SET state='needs_attention',error=?,updated_at=? WHERE id=?", (str(response.get("error", "ASR 失败"))[:1000], now(), job_id))
            return self.store.one("jobs", job_id)
        if response.get("state") != "completed":
            return {**row, "asr_state": response.get("state"), "pending": True}
        result = self.call("result", row["external_id"])
        words = result.get("words")
        if not isinstance(words, list) or not words:
            raise WorkbenchError("ASR 没有返回带时间定位的文字")
        segments = []
        for word in words:
            if not str(word.get("text", "")).strip():
                continue
            if not segments or segments[-1]["speaker"] != word.get("speaker") or word["start"] - segments[-1]["start"] >= 10:
                segments.append({"start": word["start"], "end": word["end"], "text": word["text"], "speaker": word.get("speaker")})
            else:
                seg = segments[-1]
                separator = " " if seg["text"][-1:].isascii() and seg["text"][-1:].isalnum() and word["text"][:1].isascii() and word["text"][:1].isalnum() else ""
                seg["text"] += separator + word["text"]
                seg["end"] = max(seg["end"], word["end"])
        version = "asr_" + row["external_id"]
        transcript = Facts(self.store).transcript(row["asset_id"], version, segments)
        raw_path = f"transcripts/{transcript['transcript_id']}/asr_original.json"
        atomic_write(self.store.config.stored_file(raw_path), encode(result).encode())
        with self.store.transaction() as db:
            db.execute("UPDATE jobs SET state='ready',result=?,error=NULL,updated_at=? WHERE id=? AND state!='completed'", (encode({"transcript_id": transcript["transcript_id"], "asr_original": raw_path}), now(), job_id))
        return {**self.store.one("jobs", job_id), "pending": False, "transcript": transcript}
