"""Fictional DingTalk receipts and Hermes hook surfaces; no external messages."""
import copy
import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from workbench.gateway_delivery import enable_file_delivery, file_receipt, register, recover_delivery_state, retry_requested, watch


class GatewayDeliveryTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='fictional-gateway-delivery-')
        self.root = Path(self.temp.name)
        (self.root / 'output/nested').mkdir(parents=True)
        self.calls, self.sent, self.cards = [], [], []
        self.state = {'state': 'delivering', 'stage': 'completed', 'gpt_preset': None, 'turn': 'fictional-turn',
                      'messages': [{'turnId': 'fictional-turn', 'phase': 'final', 'text': '虚构成品已经生成。'}]}
        async def control(*args):
            return {'files': [{'name': str(p.relative_to(self.root / 'output')), 'size': p.stat().st_size,
                               'modified': p.stat().st_mtime_ns} for p in sorted((self.root / 'output').rglob('*')) if p.is_file()]}
        self.backend = SimpleNamespace(load=lambda sid: copy.deepcopy(self.state), store=self.store, control=control,
            folder=lambda sid: self.root, artifact_path=lambda sid, name: self.root / 'output' / name,
            TIERS=SimpleNamespace(PRESETS={}))
        async def deliver(job, text, finished):
            self.calls.append(('card', finished))
            self.cards.append(text)
        self.router = SimpleNamespace(deliver=deliver, read=lambda *args: {'courseware_session': 'fictional-session'},
            save=lambda *args: None, LOG=SimpleNamespace(exception=lambda *args: None))
        self.adapter = SimpleNamespace(_teacher_file_sender=self.sender)
        self.job = {'source': {'chat_id': 'fictional-chat'}, 'staff': 'fictional-staff', 'robot': 'fictional-robot'}
        self.failing = set()

    def tearDown(self):
        self.temp.cleanup()

    def store(self, state):
        self.state = copy.deepcopy(state)

    async def sender(self, adapter, job, path):
        self.assertEqual(job['source']['chat_id'], 'fictional-chat')
        self.calls.append(('file', path.name))
        if path.name in self.failing:
            raise RuntimeError('fictional provider failure')
        self.sent.append(path.name)
        return {'state': 'sent', 'external_ref': 'fictional-receipt-' + path.name}

    async def test_every_file_type_and_nested_result_is_sent_before_final_card(self):
        for name in ('fictional.pptx', 'nested/fictional.custom'):
            (self.root / 'output' / name).write_bytes(b'EXPLICITLY FICTIONAL ARTIFACT 7319')
        await watch(self.router, self.adapter, self.job, 'fictional-session', 'fictional-turn', 'fictional-key', self.backend)
        self.assertEqual(set(self.sent), {'fictional.pptx', 'fictional.custom'})
        self.assertEqual(self.calls[-1], ('card', True))
        self.assertEqual(self.state['delivery_state'], 'sent')
        self.assertEqual(self.state['stage'], 'completed')
        self.assertEqual(self.state['state'], 'idle')

    async def test_failed_send_preserves_files_and_retry_sends_only_unsent_results(self):
        for name in ('fictional-a.txt', 'fictional-b.mp4'):
            (self.root / 'output' / name).write_bytes(b'EXPLICITLY FICTIONAL ARTIFACT 7319')
        self.failing.add('fictional-b.mp4')
        await watch(self.router, self.adapter, self.job, 'fictional-session', 'fictional-turn', 'fictional-key', self.backend)
        self.assertEqual(self.state['stage'], 'delivery_failed')
        self.assertEqual(self.state['delivery_state'], 'failed')
        self.assertIn('尚未完整交付', self.cards[-1])
        self.assertTrue(retry_requested(self.state, '重发', []))
        self.assertFalse(retry_requested(self.state, '重新制作另一个视频', []))
        self.failing.clear()
        await watch(self.router, self.adapter, self.job, 'fictional-session', 'fictional-turn', 'fictional-key', self.backend)
        self.assertEqual(self.sent.count('fictional-a.txt'), 1)
        self.assertEqual(self.sent.count('fictional-b.mp4'), 1)
        self.assertEqual(self.state['delivery_state'], 'sent')
        self.assertNotIn('尚未完整交付', self.cards[-1])

    async def test_text_or_link_only_production_cannot_claim_file_delivery(self):
        self.state['messages'][0]['text'] = '[下载成品](https://fictional.invalid/lesson.pptx)'
        await watch(self.router, self.adapter, self.job, 'fictional-session', 'fictional-turn', 'fictional-key', self.backend)
        self.assertEqual(self.sent, [])
        self.assertEqual(self.state['stage'], 'delivery_failed')
        self.assertNotEqual(self.state['delivery_state'], 'sent')
        self.assertIn('尚未完整交付', self.cards[-1])

    async def test_interrupted_sender_keeps_receipts_and_recovers_without_reproduction(self):
        for name in ('fictional-a.txt', 'fictional-b.mp4'):
            (self.root / 'output' / name).write_bytes(b'EXPLICITLY FICTIONAL ARTIFACT 7319')
        first = self.root / 'output/fictional-a.txt'
        self.state['main_delivered'] = {first.name: str(first.stat().st_mtime_ns) + ':' + str(first.stat().st_size)}
        self.state['file_receipts'] = {first.name: {'state': 'sent', 'external_ref': 'fictional-before-restart'}}
        self.assertTrue(recover_delivery_state(self.state))
        self.assertTrue(retry_requested(self.state, '重发', []))
        self.assertEqual(self.state['production_final'], '虚构成品已经生成。')
        await watch(self.router, self.adapter, self.job, 'fictional-session', 'fictional-turn', 'fictional-key', self.backend)
        self.assertEqual(self.sent, ['fictional-b.mp4'])
        self.assertEqual(self.state['file_receipts'][first.name]['external_ref'], 'fictional-before-restart')
        self.assertEqual(self.state['stage'], 'completed')
        self.assertIn('虚构成品已经生成', self.cards[-1])

    async def test_generic_native_attachment_uses_original_sender_and_checks_receipt(self):
        class Result:
            def __init__(self, success, message_id=None, error=None):
                self.success, self.message_id, self.error = success, message_id, error
        fallback_calls = []
        async def fallback(*args, **kwargs):
            fallback_calls.append(args)
            return Result(False, error='fictional unsupported target')
        adapter = SimpleNamespace(send_document=fallback, _client_id='fictional-robot')
        event = SimpleNamespace(source=SimpleNamespace(chat_id='fictional-chat', user_id_alt='fictional-staff'))
        path = self.root / 'fictional image.png'
        path.write_bytes(b'EXPLICITLY FICTIONAL IMAGE 7319')
        with patch.dict('sys.modules', {'gateway.platforms.base': SimpleNamespace(SendResult=Result)}):
            enable_file_delivery(adapter, event, self.sender)
        self.assertTrue((await adapter.send_document('fictional-chat', str(path))).success)
        self.assertEqual(self.sent, [path.name])
        self.assertFalse((await adapter.send_document('fictional-other-chat', str(path))).success)
        self.assertEqual(len(fallback_calls), 1)
        self.failing.add(path.name)
        self.assertFalse((await adapter.send_document('fictional-chat', str(path))).success)

    async def test_native_hook_applies_to_existing_chat_and_preserves_turn_identity_after_compaction(self):
        hooks, sections = {}, {}
        ctx = SimpleNamespace(register_hook=lambda name, cb: hooks.__setitem__(name, cb),
            register_system_prompt_section=lambda name, body, **kw: sections.__setitem__(name, body))
        class DB:
            def get_session(_self, sid): return {'cwd': str(self.root)}
            def close(_self): pass
        register(ctx)
        with patch.dict('sys.modules', {'hermes_state': SimpleNamespace(SessionDB=DB),
                                       'hermes_cli.config': SimpleNamespace(load_config=lambda: {})}):
            context = hooks['pre_llm_call'](session_id='fictional-old', turn_id='fictional-turn', platform='dingtalk')
        self.assertIn('强制成品交付要求', context['context'])
        path = self.root / 'output/fictional-old/fictional.raw'
        path.write_bytes(b'EXPLICITLY FICTIONAL GENERATED BYTES')
        text = hooks['transform_llm_output'](session_id='fictional-continuation', turn_id='fictional-turn',
            platform='dingtalk', response_text='虚构成品已生成。')
        self.assertIn('MEDIA:"' + str(path) + '"', text)
        self.assertIsNone(hooks['transform_llm_output'](session_id='fictional-other', platform='dingtalk', response_text='普通对话'))

    async def test_http_success_without_a_file_send_receipt_is_not_success(self):
        for payload in ({}, {'errcode': 1}, {'success': False}, {'processQueryKey': 'fictional', 'invalidUserIds': ['fictional-staff']}):
            with self.assertRaises(RuntimeError):
                file_receipt(payload, 'fictional-staff')
        self.assertEqual(file_receipt({'processQueryKey': 'fictional-sent'}, 'fictional-staff')['state'], 'sent')
