"""Explicitly fictional desktop conversations; no model or real teaching data."""
import tempfile
import unittest
from pathlib import Path

from workbench.chats import Chats, ChatWorker
from workbench.config import Config, WorkbenchError
from workbench.storage import Store


class ChatTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.store = Store(Config(Path(self.temp.name), "fictional-chat-tests"))
        self.chats = Chats(self.store)
        self.chats.create({"id": "fictional-a"})
        self.chats.create({"id": "fictional-b"})

    def tearDown(self):
        self.temp.cleanup()

    def submit(self, turn_id="fictional-turn-1", content="虚构教师要制作一个讲稿", chat_id="fictional-a"):
        return self.chats.submit(chat_id, {"id": turn_id, "content": content})

    def proposal(self, ready=True, model_id="gpt-6-astra"):
        return {"ready": ready, "model_id": model_id, "confidence": .9, "reason": "虚构数学任务", "category": "数学", "question": "虚构问题"}

    def test_one_chat_one_native_identity_and_idempotent_submission_survive_restart(self):
        first = self.chats.create({"id": "fictional-a"})["chat"]
        self.submit()
        self.submit()
        self.chats.delta("fictional-turn-1", "虚构流式内容")
        fresh = Chats(Store(self.store.config))
        view = fresh.read("fictional-a")
        self.assertEqual(first["hermes_session_id"], view["chat"]["hermes_session_id"])
        self.assertEqual(len(view["turns"]), 1)
        self.assertEqual(view["turns"][0]["answer"], "虚构流式内容")
        self.assertNotEqual(first["hermes_session_id"], fresh.chat("fictional-b")["hermes_session_id"])
        with self.assertRaises(WorkbenchError):
            self.submit(content="同一标识不能偷换内容")
        with self.assertRaises(WorkbenchError):
            self.submit(chat_id="fictional-b")

    def test_overlapping_turns_cannot_execute_and_different_chats_are_independent(self):
        self.submit()
        with self.assertRaises(WorkbenchError):
            self.submit("fictional-turn-2")
        self.submit("fictional-other", chat_id="fictional-b")
        self.chats.finish("fictional-turn-1", "completed", "虚构回答")
        self.submit("fictional-turn-2")
        self.assertEqual(len(self.chats.read("fictional-b")["turns"]), 1)

    def test_classifier_uses_bounded_early_turns_and_never_changes_a_locked_route(self):
        self.chats.route("fictional-a", None, self.proposal(), 1)
        self.assertEqual(self.chats.chat("fictional-a")["route_state"], "triage")
        self.chats.route("fictional-a", None, self.proposal(False), 2)
        self.assertEqual(self.chats.chat("fictional-a")["route_state"], "triage")
        self.chats.route("fictional-a", None, self.proposal(), 2)
        self.assertEqual(self.chats.chat("fictional-a")["model_id"], "gpt-6-astra")
        self.chats.route("fictional-a", None, self.proposal(model_id="deepseek-flash"), 3)
        self.assertEqual(self.chats.chat("fictional-a")["model_id"], "gpt-6-astra")
        with self.assertRaises(WorkbenchError):
            self.chats.route("fictional-b", None, self.proposal(model_id="fictional-unavailable"), 3)
        self.chats.route("fictional-b", None, self.proposal(False), 3)
        self.assertEqual(self.chats.chat("fictional-b")["route_state"], "locked")

    def test_manual_switch_is_explicit_and_cannot_race_a_running_turn(self):
        self.chats.select_model("fictional-a", {"model_id": "gpt-6-sol"})
        self.assertEqual(self.chats.chat("fictional-a")["model_id"], "gpt-6-sol")
        self.submit()
        with self.assertRaises(WorkbenchError):
            self.chats.select_model("fictional-a", {"model_id": "deepseek-flash"})
        self.chats.cancel("fictional-a")
        self.assertEqual(self.chats.turn("fictional-turn-1")["state"], "cancelled")
        self.chats.select_model("fictional-a", {"model_id": "auto"})
        self.assertEqual(self.chats.chat("fictional-a")["route_state"], "triage")

    def test_stop_and_restart_keep_partial_output_and_never_report_business_completion(self):
        self.submit()
        with self.store.transaction() as db:
            db.execute("UPDATE desktop_turns SET state='running' WHERE id='fictional-turn-1'")
        self.chats.delta("fictional-turn-1", "虚构部分内容")
        self.chats.cancel("fictional-a")
        self.chats.finish("fictional-turn-1", "completed", "停止时保留的虚构内容")
        self.assertEqual(self.chats.turn("fictional-turn-1")["state"], "cancelled")
        self.submit("fictional-turn-2")
        with self.store.transaction() as db:
            db.execute("UPDATE desktop_turns SET state='running' WHERE id='fictional-turn-2'")
        worker = ChatWorker(self.chats)
        worker.stop_event.set()  # Only recovery is tested, no model process is launched.
        worker.start()
        worker.stop()
        self.assertEqual(self.chats.turn("fictional-turn-2")["state"], "interrupted")
        self.chats.delta("fictional-turn-2", "不能把迟到输出插入已终止的回复")
        self.assertEqual(self.chats.turn("fictional-turn-2")["answer"], "")
        with self.store.connect() as db:
            self.assertEqual(db.execute("SELECT COUNT(*) FROM artifacts").fetchone()[0], 0)
            self.assertEqual(db.execute("SELECT COUNT(*) FROM jobs").fetchone()[0], 0)

    def test_cursor_replay_contains_each_delta_once_and_snapshot_matches_final_answer(self):
        self.submit()
        before = self.chats.read("fictional-a")["cursor"]
        self.chats.delta("fictional-turn-1", "虚构 A")
        self.chats.delta("fictional-turn-1", "虚构 B")
        events = self.chats.events("fictional-a", before)
        self.assertEqual("".join(e["payload"]["text"] for e in events), "虚构 A虚构 B")
        self.assertEqual(self.chats.events("fictional-a", events[-1]["seq"]), [])
        self.chats.finish("fictional-turn-1", "completed", "虚构最终回答")
        view = self.chats.read("fictional-a")
        self.assertEqual(view["turns"][0]["answer"], "虚构最终回答")
        self.assertEqual(self.chats.events("fictional-a", view["cursor"]), [])

    def test_business_restore_preserves_chat_mapping_but_never_reexecutes_external_turns(self):
        self.submit()
        self.chats.delta("fictional-turn-1", "虚构已保存内容")
        backup = self.store.backup()
        destination = self.store.root / "fictional-restored"
        Store.restore(self.store.root / "backups" / backup["backup_id"], destination)
        restored = Chats(Store(Config(destination, "fictional-chat-tests")))
        view = restored.read("fictional-a")
        self.assertEqual(view["chat"]["hermes_session_id"], self.chats.chat("fictional-a")["hermes_session_id"])
        self.assertEqual(view["turns"][0]["state"], "interrupted")
        self.assertEqual(view["turns"][0]["answer"], "虚构已保存内容")

    def test_archive_restores_the_same_history_and_does_not_cancel_or_resubmit_a_turn(self):
        self.submit()
        self.chats.delta("fictional-turn-1", "虚构已保存片段")
        archived = self.chats.archive("fictional-a", {"archived": True})
        self.assertTrue(archived["chat"]["archived_at"])
        self.assertEqual(archived["turns"][0]["state"], "queued")
        self.assertEqual(self.submit()["id"], "fictional-turn-1")
        cursor = archived["cursor"]
        self.assertEqual(self.chats.archive("fictional-a", {"archived": True})["cursor"], cursor)
        self.chats.finish("fictional-turn-1", "completed", "虚构保存的回答")
        with self.assertRaises(WorkbenchError):
            self.submit("fictional-turn-2")
        fresh = Chats(Store(self.store.config))
        self.assertTrue(fresh.chat("fictional-a")["archived_at"])
        self.assertFalse(fresh.chat("fictional-b")["archived_at"])
        restored = fresh.archive("fictional-a", {"archived": False})
        self.assertIsNone(restored["chat"]["archived_at"])
        self.assertEqual(restored["chat"]["hermes_session_id"], archived["chat"]["hermes_session_id"])
        self.assertEqual(restored["turns"][0]["answer"], "虚构保存的回答")
        fresh.submit("fictional-a", {"id": "fictional-turn-2", "content": "虚构续聊"})
        with self.assertRaises(WorkbenchError):
            fresh.archive("fictional-a", {"archived": "false"})

    def test_semantic_title_is_validated_and_preserves_archive_model_and_original_content(self):
        self.chats.select_model("fictional-a", {"model_id": "gpt-6-sol"})
        self.submit(content="虚构问候：在吗")
        self.chats.archive("fictional-a", {"archived": True})
        for invalid in (None, {}, "", "你好", "标题\n换行", "虚" * 29):
            self.assertFalse(self.chats.auto_title("fictional-a", invalid))
        self.assertTrue(self.chats.auto_title("fictional-a", "虚构课堂讲稿制作"))
        self.assertFalse(self.chats.auto_title("fictional-a", "迟到的另一个分类标题"))
        fresh = Chats(Store(self.store.config))
        view = fresh.read("fictional-a")
        self.assertEqual(view["chat"]["title"], "虚构课堂讲稿制作")
        self.assertEqual(view["chat"]["title_source"], "ai")
        self.assertTrue(view["chat"]["archived_at"])
        self.assertEqual(view["chat"]["model_id"], "gpt-6-sol")
        self.assertEqual(view["turns"][0]["content"], "虚构问候：在吗")
        self.assertEqual(fresh.events("fictional-a", 0)[-1]["payload"]["title"], "虚构课堂讲稿制作")

    def test_legacy_chat_database_gains_metadata_without_changing_native_history(self):
        self.submit()
        native_id = self.chats.chat("fictional-a")["hermes_session_id"]
        with self.store.transaction() as db:
            db.execute("DROP TABLE desktop_chat_metadata")
        upgraded = Chats(Store(self.store.config))
        view = upgraded.read("fictional-a")
        self.assertEqual(view["chat"]["hermes_session_id"], native_id)
        self.assertEqual(view["chat"]["title_source"], "fallback")
        self.assertIsNone(view["chat"]["archived_at"])
        self.assertEqual(len(view["turns"]), 1)
        self.assertTrue(upgraded.auto_title("fictional-a", "虚构讲稿制作"))


if __name__ == "__main__":
    unittest.main()
