"""Synthetic transport/model/native surfaces. No real teaching records or sends."""
import asyncio
from dataclasses import dataclass, asdict
import json
import logging
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest

from workbench.gateway_tasks import TaskStore, TaskRuntime, RouteError, media_only, media_names, route
from ops.install_task_routing import prepare


def proposal(action='new', tid=None, title='虚构函数PPT', **extra):
    return dict(action=action, task_id=tid, title=title, confidence=.98, **extra)


class StoreTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='fictional-task-routing-')
        self.store = TaskStore(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def message(self, mid, text='虚构请求', owner='fictional-owner', media=None):
        return self.store.receive(owner, mid, {'text': text, 'media': media or []})[0]

    def new(self, mid, **kwargs):
        seq = self.message(mid, **kwargs)
        return seq, self.store.enqueue(seq, proposal())

    def test_duplicate_is_durable_and_conflicting_redelivery_rejected(self):
        seq, tid = self.new('fictional-1')
        reopened = TaskStore(self.tmp.name)
        self.assertEqual(reopened.receive('fictional-owner', 'fictional-1', {'text': '虚构请求', 'media': []}), (seq, False))
        with self.assertRaises(RouteError):
            reopened.receive('fictional-owner', 'fictional-1', {'text': '被更改的虚构请求', 'media': []})
        self.assertEqual(len(reopened.context('fictional-owner')['tasks']), 1)

    def test_parallel_tasks_but_serial_messages_in_one_task(self):
        a, ta = self.new('a')
        b, tb = self.new('b')
        c = self.message('c')
        self.store.enqueue(c, proposal('resume', ta))
        self.assertEqual(self.store.claim()['seq'], a)
        self.assertEqual(self.store.claim()['seq'], b)
        self.assertIsNone(self.store.claim())
        self.store.finish(a, 'done', {'text': '虚构回复'})
        self.assertEqual(self.store.claim()['seq'], c)
        self.assertNotEqual(ta, tb)

    def test_completion_does_not_steal_focus(self):
        a, ta = self.new('a')
        _, tb = self.new('b')
        self.store.finish(a, 'done', {'text': '虚构课件结果'})
        self.assertEqual(self.store.context('fictional-owner')['focus'], tb)
        self.assertEqual(self.store.task('fictional-owner', tb)['last_answer'], '')

    def test_foreign_task_and_reply_reference_cannot_route(self):
        _, ta = self.new('a')
        b = self.message('b', owner='fictional-other')
        with self.assertRaises(RouteError):
            self.store.enqueue(b, proposal('resume', ta))
        self.store.bind('fictional-owner', 'fictional-reply', ta)
        self.assertIsNone(self.store.reference('fictional-other', 'fictional-reply'))

    def test_unknown_task_and_low_confidence_do_not_create_anything(self):
        seq = self.message('a')
        for p in [proposal('resume', 'invented'), {**proposal(), 'confidence': .3},
                  {**proposal(), 'confidence': float('nan')}, {**proposal(), 'confidence': True}]:
            with self.assertRaises(RouteError):
                self.store.enqueue(seq, p)
        self.assertEqual(self.store.context('fictional-owner')['tasks'], [])

    def test_quoted_target_beats_model_choice(self):
        _, ta = self.new('a')
        _, tb = self.new('b')
        c = self.message('c')
        self.assertEqual(self.store.enqueue(c, proposal('resume', tb), forced=ta), ta)

    def test_clarification_preserves_original_files_and_does_not_consume_new_topic(self):
        _, ta = self.new('a')
        original = self.message('b', text='虚构颜色淡一点', media=['fictional.png'])
        self.store.clarify(original, '哪一项？')
        separate = self.message('c', text='先问个生活问题')
        self.store.enqueue(separate, proposal(title='虚构生活话题'))
        self.assertEqual(self.store.context('fictional-owner')['pending']['seq'], original)
        answer = self.message('d', text='是虚构函数PPT')
        self.store.enqueue(answer, proposal('resume', ta, resolves_pending=True))
        queued = self.store.message(answer)
        self.assertIn('颜色淡一点', queued['payload']['text'])
        self.assertEqual(queued['payload']['media'], ['fictional.png'])
        self.assertIsNone(self.store.context('fictional-owner')['pending'])
        self.assertEqual(self.store.message(original)['state'], 'resolved')

    def test_restart_does_not_repeat_running_work_or_run_its_dependents(self):
        seq, tid = self.new('a')
        follow = self.message('b')
        self.store.enqueue(follow, proposal('resume', tid))
        self.store.claim()
        reopened = TaskStore(self.tmp.name)
        reopened.recover()
        self.assertEqual(reopened.message(seq)['state'], 'interrupted')
        self.assertIsNone(reopened.claim())
        _, other = self.new('c')
        self.assertEqual(reopened.claim()['task_id'], other)

    def test_restart_retains_generated_result_and_file_receipts_for_retry(self):
        seq, tid = self.new('a')
        self.store.claim()
        result = {'text': '虚构正文', 'files': ['fictional.pdf'], 'receipts': {'fictional.pdf': {'state':'sent'}}}
        self.store.set_message(seq, 'running', result)
        self.store.recover()
        self.assertEqual(self.store.message(seq)['state'], 'delivery_failed')
        self.assertEqual(self.store.message(seq)['result'], result)
        self.assertEqual(self.store.task('fictional-owner', tid)['state'], 'delivery_failed')

    def test_staging_message_cannot_be_overtaken_by_its_followup(self):
        first = self.message('a')
        tid = self.store.enqueue(first, proposal(), staging=True)
        second = self.message('b')
        self.store.enqueue(second, proposal('resume', tid))
        self.assertIsNone(self.store.claim())
        self.store.set_message(first, 'queued')
        self.assertEqual(self.store.claim()['seq'], first)

    def test_failed_delivery_blocks_modification_and_prioritizes_retry(self):
        seq, tid = self.new('a')
        follow = self.message('b')
        self.store.enqueue(follow, proposal('resume', tid))
        self.store.claim()
        self.store.finish(seq, 'delivery_failed', {'text': '虚构成果', 'files': ['fictional.pdf']})
        self.assertIsNone(self.store.claim())
        bad = self.message('c')
        with self.assertRaises(RouteError):
            self.store.enqueue(bad, proposal('resume', tid))
        retry = self.message('d', text='重发')
        self.store.enqueue(retry, proposal('retry_delivery', tid))
        self.assertEqual(self.store.claim()['seq'], retry)

    def test_legacy_history_is_imported_once_not_copied_to_new_task(self):
        old = {'topic': 'fictional-old', 'hermes_session': 'fictional-session', 'title': '虚构旧任务'}
        router = SimpleNamespace(read=lambda *args: old)
        self.store.migrate(router, 'fictional-owner')
        self.store.migrate(router, 'fictional-owner')
        tasks = self.store.context('fictional-owner')['tasks']
        self.assertEqual(len(tasks), 1)
        self.assertEqual(self.store.task('fictional-owner', tasks[0]['id'])['settings'], old)
        _, new = self.new('new')
        self.assertEqual(self.store.task('fictional-owner', new)['settings'], {})


@dataclass
class Source:
    platform: object
    profile: str = 'fictional'
    chat_id: str = 'fictional-dm'
    user_id: str = 'fictional-user'
    user_id_alt: str = 'fictional-staff'
    chat_type: str = 'dm'


class MediaShapeTests(unittest.TestCase):
    def test_native_sdk_file_fallback_is_not_a_prompt_but_real_caption_is(self):
        raw = SimpleNamespace(message_type='file', text=None,
                              extensions={'content': {'fileName': '虚构请做PPT.pdf'}})
        event = SimpleNamespace(text='[文件] 虚构请做PPT.pdf', raw_message=raw,
                                media_urls=['https://fictional.invalid/download?id=1'])
        self.assertTrue(media_only(event))
        self.assertEqual(media_names(event), ['虚构请做PPT.pdf'])
        raw.text = SimpleNamespace(content='[文件] 这是真实输入结构的虚构文字要求')
        self.assertFalse(media_only(event))

    def test_legacy_and_current_rich_text_preserve_captions_and_names(self):
        items = [{'type': 'picture', 'downloadCode': 'fictional-image', 'fileName': '虚构照片.png'}]
        raw = SimpleNamespace(message_type='richText', text=None, rich_text=items)
        event = SimpleNamespace(text='', raw_message=raw, media_urls=['fictional-image'])
        self.assertTrue(media_only(event))
        self.assertEqual(media_names(event), ['虚构照片.png'])
        items.append({'type': 'text', 'text': '虚构课件要求'})
        self.assertFalse(media_only(event))
        del raw.rich_text
        raw.rich_text_content = SimpleNamespace(rich_text_list=items)
        self.assertFalse(media_only(event))


class RuntimeTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='fictional-task-runtime-')
        self.source = Source(SimpleNamespace(value='dingtalk'))
        self.sent, self.files, self.classifications, self.runs = [], [], [], []
        self.decisions = []
        self.fail_files = set()
        self.saved = {}
        async def send(chat_id, text, reply_to=None):
            self.sent.append((chat_id, text, reply_to))
            return SimpleNamespace(success=True, message_id='fictional-out-' + str(len(self.sent)))
        async def send_file(adapter, job, path):
            if path.name in self.fail_files:
                raise RuntimeError('fictional delivery failure')
            self.files.append((job['staff'], path.name))
            return {'state': 'sent', 'external_ref': 'fictional-file-' + path.name}
        async def deliver(job, text, finished=False):
            self.sent.append((job['source']['chat_id'], text, job.get('inbound')))
            job['card_created'] = True
            self.last_reply_id = job['id']
        async def ask(prompt, context):
            self.classifications.append(context)
            value = self.decisions.pop(0)
            if isinstance(value, Exception):
                raise value
            return value
        async def classify(settings, text, paths):
            return dict(engine='deepseek', gpt_pinned=False, gpt_preset='sol_max', workflow='chat')
        self.adapter = SimpleNamespace(send=send, _client_id='fictional-robot')
        self.gateway = SimpleNamespace(_delivery_adapter_for=lambda source: self.adapter)
        self.router = SimpleNamespace(HOME=Path(self.tmp.name), identity=lambda source: source.user_id,
            source_restore=lambda data: Source(SimpleNamespace(value=data['platform']), **{k:v for k,v in data.items() if k!='platform'}),
            read=lambda table,key: self.saved.get(key), save=lambda table,key,value:self.saved.update({key:dict(value)}),
            ask_json=ask, classify=classify, normalize=lambda p,s,m:p, deliver=deliver, LOG=logging.getLogger('fictional-task-tests'),
            COURSEWARE=SimpleNamespace(send_file=send_file))
        self.runtime = TaskRuntime(self.router, self.gateway)
        self.gates = {}
        async def native(row, task, settings, paths):
            self.runs.append((task['id'], row['payload']['text'], paths, dict(settings)))
            if row['payload']['text'] in self.gates:
                await self.gates[row['payload']['text']].wait()
            return {'state': 'completed', 'text': '虚构回复：' + row['payload']['text'], 'files': [],
                    'session_id': 'fictional-native-' + task['id']}
        self.runtime.native_turn = native

    async def asyncTearDown(self):
        await self.runtime.stop()
        self.tmp.cleanup()

    def event(self, mid, text='虚构消息', media=None, reply=None):
        return SimpleNamespace(source=self.source, message_id=mid, text=text, media_urls=media or [], reply_to=reply)

    def upload(self, mid, name, text='', raw=None):
        path = Path(self.tmp.name) / ('source-' + mid)
        path.write_text('FICTIONAL_MATERIAL_' + mid, encoding='utf-8')
        event = self.event(mid, text, [str(path)])
        event.raw_message = raw or SimpleNamespace(message_type='file', text=None, extensions={'content': {'fileName': name}})
        return event

    async def wait_for(self, predicate):
        async with asyncio.timeout(4):
            while not predicate():
                await asyncio.sleep(.01)

    async def accept(self, event):
        async with asyncio.timeout(8):
            await self.runtime.accept(event)
            if self.runtime.intakes:
                await asyncio.gather(*self.runtime.intakes)

    async def test_actual_pump_concurrency_serial_followups_and_no_context_bleed(self):
        self.runtime.start()
        self.gates['虚构慢PPT'] = asyncio.Event()
        self.decisions.append(proposal(title='虚构PPT'))
        await self.accept(self.event('a', '虚构慢PPT'))
        first = self.runtime.store.context('fictional-user')['focus']
        await self.wait_for(lambda: len(self.runs) == 1)
        self.decisions.append(proposal('resume', first))
        await self.accept(self.event('b', '虚构改第二页'))
        self.decisions.append(proposal(title='虚构晚餐'))
        await self.accept(self.event('c', '虚构晚餐问题'))
        second = self.runtime.store.context('fictional-user')['focus']
        await self.wait_for(lambda: any('虚构晚餐问题' in text for _,text,_ in self.sent))
        self.assertEqual(len(self.runs), 2)
        self.assertNotEqual(first, second)
        self.assertNotIn('history', self.runs[1][3])
        self.gates['虚构慢PPT'].set()
        await self.wait_for(lambda: len(self.runs) == 3)
        self.assertEqual(self.runs[2][0], first)
        self.assertIn('虚构慢PPT', str(self.runs[2][3]['history']))
        self.assertNotIn('虚构晚餐问题', str(self.runs[2][3]))
        self.assertEqual(self.runtime.store.context('fictional-user')['focus'], second)

    async def test_reply_mapping_bypasses_guess_and_keeps_task(self):
        self.decisions.append(proposal())
        await self.accept(self.event('a'))
        tid = self.runtime.store.context('fictional-user')['focus']
        await self.accept(self.event('b', '虚构修改', reply=self.last_reply_id))
        self.assertEqual(len(self.classifications), 1)
        self.assertEqual(self.runtime.store.context('fictional-user')['focus'], tid)

    async def test_courseware_and_video_own_sessions_watchers_and_reply_cards(self):
        states, starts, gate = {}, [], asyncio.Event()
        async def classify(settings, text, media):
            return dict(engine='deepseek', gpt_pinned=False, gpt_preset='sol_max',
                        workflow='teaching_video' if '视频' in text else 'courseware')
        async def handle(router,event,adapter,chat,key,job):
            sid = 'fictional-production-' + chat['topic']
            chat['courseware_session'] = sid
            self.saved[key] = dict(chat)
            states[sid] = {'stage':'intake', 'state':'active', 'progress_text':event.text}
            starts.append((sid,key,job['id'],event.text))
            async def watch():
                await gate.wait()
                await router.deliver(job,event.text,True)
                states[sid]['state']='idle'
            self.router.COURSEWARE.WATCHERS[sid] = asyncio.create_task(watch())
        self.router.classify=classify
        self.router.COURSEWARE.handle=handle
        self.router.COURSEWARE.B=SimpleNamespace(load=lambda sid:states[sid])
        self.router.COURSEWARE.WATCHERS={}
        self.runtime.start()
        self.decisions.append(proposal(title='虚构函数PPT'))
        await self.accept(self.event('ppt','虚构PPT需求'))
        self.decisions.append(proposal(title='虚构函数视频'))
        await self.accept(self.event('video','虚构视频需求'))
        await self.wait_for(lambda:len(starts)==2)
        self.assertNotEqual(starts[0][:3],starts[1][:3])
        self.assertNotEqual(starts[0][0],starts[1][0])
        self.assertNotEqual(starts[0][1],starts[1][1])
        self.assertNotEqual(starts[0][2],starts[1][2])
        gate.set()
        await self.wait_for(lambda:all(t['state']=='idle' for t in self.runtime.store.context('fictional-user')['tasks']))
        answers=[text for _,text,_ in self.sent]
        self.assertIn('「虚构函数PPT」\n虚构PPT需求',answers)
        self.assertIn('「虚构函数视频」\n虚构视频需求',answers)

    async def test_classifier_outage_never_falls_through_or_executes(self):
        self.decisions.append(RuntimeError('fictional outage'))
        await self.accept(self.event('a'))
        self.assertIsNone(self.runtime.store.claim())
        self.assertEqual(self.runtime.store.context('fictional-user')['tasks'], [])
        self.decisions.append(proposal())
        await self.accept(self.event('a'))
        self.assertIsNotNone(self.runtime.store.claim())

    async def test_retry_sends_only_missing_files_without_generation(self):
        self.decisions.append(proposal())
        await self.accept(self.event('a'))
        row = self.runtime.store.claim()
        task = self.runtime.store.task(row['owner'], row['task_id'])
        result = {'text': '虚构完整正文', 'files': ['fictional-a.pdf', 'fictional-b.png']}
        self.fail_files.add('fictional-b.png')
        self.runtime.store.set_message(row['seq'], 'running', result)
        with self.assertRaises(RuntimeError):
            await self.runtime.send_result(row, task, self.source, self.adapter, {'staff':'fictional-staff'}, result)
        self.runtime.store.finish(row['seq'], 'delivery_failed', result)
        self.fail_files.clear()
        self.decisions.append(proposal('retry_delivery', task['id']))
        await self.accept(self.event('b', '重发'))
        retry = self.runtime.store.claim()
        await self.runtime.execute(retry)
        self.assertEqual(self.files, [('fictional-staff','fictional-a.pdf'), ('fictional-staff','fictional-b.png')])
        self.assertEqual(self.runs, [])
        self.assertEqual(self.runtime.store.message(row['seq'])['state'], 'done')

    async def test_repeated_delivery_failure_preserves_original_and_blocks_new_generation(self):
        self.decisions.append(proposal())
        await self.accept(self.event('a'))
        row = self.runtime.store.claim()
        tid = row['task_id']
        self.runtime.store.finish(row['seq'], 'delivery_failed', {'text':'虚构正文', 'files':['fictional-fail.png']})
        self.fail_files.add('fictional-fail.png')
        self.decisions.append(proposal('retry_delivery', tid))
        await self.accept(self.event('b', '重发'))
        await self.runtime.execute(self.runtime.store.claim())
        self.assertEqual(self.runtime.store.message(row['seq'])['state'], 'delivery_failed')
        self.assertEqual(self.runtime.store.task(row['owner'], tid)['state'], 'delivery_failed')
        self.fail_files.clear()
        self.decisions.append(proposal('retry_delivery', tid))
        await self.accept(self.event('c', '再次重发'))
        await self.runtime.execute(self.runtime.store.claim())
        self.assertEqual(self.runtime.store.message(row['seq'])['state'], 'done')
        self.assertEqual(self.runs, [])

    async def test_attachment_is_copied_into_only_its_task(self):
        path = Path(self.tmp.name) / 'fictional.txt'
        path.write_text('fictional material', encoding='utf-8')
        self.decisions.append(proposal())
        await self.accept(self.event('a', media=[str(path)]))
        row = self.runtime.store.claim()
        paths = await self.runtime.stage_media(row)
        self.assertIn(row['task_id'], paths[0])
        self.assertEqual(Path(paths[0]).read_text(encoding='utf-8'), 'fictional material')
        self.decisions.append(proposal(title='虚构另一任务'))
        await self.accept(self.event('b'))
        other = self.runtime.store.claim()
        self.assertEqual(await self.runtime.stage_media(other), [])

    async def test_burst_uploads_wait_for_one_prompt_and_consume_once_in_order(self):
        first = self.upload('photo-a', '虚构第一页.png')
        second = self.upload('file-b', '虚构资料.pdf', '[文件] 虚构资料.pdf')
        await self.accept(first)
        await self.accept(second)
        batch = self.runtime.store.context('fictional-user')['material_batch']
        self.assertEqual([f['name'] for f in batch['files']], ['虚构第一页.png', '虚构资料.pdf'])
        self.assertEqual(self.classifications, [])
        self.assertEqual(self.runtime.store.context('fictional-user')['tasks'], [])
        self.assertIsNone(self.runtime.store.claim())
        self.assertEqual(len(self.sent), 1)  # One batch notice, no per-image spam.
        self.decisions.append(proposal(use_materials=True))
        prompt = self.event('prompt', '根据上面的虚构图片和资料制作PPT')
        await self.accept(prompt)
        row = self.runtime.store.claim()
        self.assertEqual([Path(p).read_text(encoding='utf-8') for p in row['payload']['local_media']],
                         ['FICTIONAL_MATERIAL_photo-a', 'FICTIONAL_MATERIAL_file-b'])
        self.assertTrue(all(row['task_id'] in p for p in row['payload']['local_media']))
        self.assertIsNone(self.runtime.store.materials('fictional-user'))
        self.assertEqual(self.runtime.store.reference('fictional-user', 'photo-a'), row['task_id'])
        await self.runtime.execute(row)
        await self.accept(first)
        await self.accept(prompt)
        self.assertEqual(len(self.runs), 1)
        self.assertEqual(len(self.classifications), 1)
        await self.accept(self.upload('later-c', '虚构新材料.docx'))
        self.assertNotEqual(self.runtime.store.materials('fictional-user')['id'], batch['id'])

    async def test_life_question_status_and_reset_leave_materials_available(self):
        await self.accept(self.upload('a', '虚构照片.png'))
        batch = self.runtime.store.materials('fictional-user')['id']
        self.decisions.append(proposal(title='虚构晚餐', use_materials=False))
        await self.accept(self.event('b', '晚餐怎么做？'))
        row = self.runtime.store.claim()
        self.assertEqual(row['payload']['local_media'], [])
        self.assertEqual(self.classifications[-1]['material_batch']['id'], batch)
        self.assertEqual(self.classifications[-1]['recent_user_messages'], ['晚餐怎么做？'])
        await self.runtime.execute(row)
        await self.accept(self.event('c', '/tasks'))
        self.assertIn('待用素材：1 个', self.sent[-1][1])
        await self.accept(self.event('d', '/new'))
        self.assertEqual(self.runtime.store.materials('fictional-user')['id'], batch)
        self.decisions.append(proposal(use_materials=True))
        await self.accept(self.event('e', '用刚上传的虚构照片做课件'))
        used = self.runtime.store.claim()
        self.assertEqual(len(used['payload']['local_media']), 1)
        self.assertNotEqual(used['task_id'], row['task_id'])

    async def test_ambiguous_prompt_keeps_materials_and_original_until_selected(self):
        self.decisions.append(proposal(title='虚构已有PPT'))
        await self.accept(self.event('task', '制作虚构已有PPT'))
        original_task = self.runtime.store.claim()
        await self.runtime.execute(original_task)
        await self.accept(self.upload('photo', '虚构图片.png'))
        bid = self.runtime.store.materials('fictional-user')['id']
        self.decisions.append(proposal('clarify', question='这些图片要用于哪项虚构任务？', use_materials=True))
        await self.accept(self.event('prompt', '把这些虚构图片放进去'))
        self.assertEqual(self.runtime.store.materials('fictional-user')['id'], bid)
        self.assertIsNone(self.runtime.store.claim())
        self.decisions.append(proposal(title='虚构生活', use_materials=False))
        await self.accept(self.event('life', '先问个晚餐问题'))
        life = self.runtime.store.claim()
        self.assertEqual(life['payload']['local_media'], [])
        await self.runtime.execute(life)
        self.decisions.append(proposal('resume', original_task['task_id'], resolves_pending=True, use_materials=True))
        await self.accept(self.event('answer', '是虚构已有PPT'))
        selected = self.runtime.store.claim()
        self.assertIn('把这些虚构图片放进去', selected['payload']['text'])
        self.assertEqual(selected['task_id'], original_task['task_id'])
        self.assertEqual(len(selected['payload']['local_media']), 1)
        self.assertIsNone(self.runtime.store.context('fictional-user')['pending'])
        self.assertIsNone(self.runtime.store.materials('fictional-user'))

    async def test_other_user_cannot_take_a_pending_batch(self):
        await self.accept(self.upload('owner-a', '虚构私有照片.png'))
        self.source = Source(SimpleNamespace(value='dingtalk'), user_id='fictional-other')
        self.decisions.append(proposal(title='虚构外来任务', use_materials=True))
        await self.accept(self.event('other', '用上面的图片'))
        self.assertIsNone(self.classifications[-1]['material_batch'])
        self.assertEqual(self.runtime.store.context('fictional-other')['tasks'], [])
        self.assertIsNotNone(self.runtime.store.materials('fictional-user'))
        self.assertIsNone(self.runtime.store.claim())

    async def test_caption_is_a_prompt_and_does_not_take_unrelated_batch(self):
        await self.accept(self.upload('pending', '虚构课堂照片.png'))
        explicit = self.upload('caption', '虚构贺卡.png', '为这张虚构图片加生日文字',
            SimpleNamespace(message_type='picture', text=SimpleNamespace(content='为这张虚构图片加生日文字')))
        self.decisions.append(proposal(title='虚构生日图片', use_materials=False))
        await self.accept(explicit)
        row = self.runtime.store.claim()
        self.assertEqual(len(row['payload']['local_media']), 1)
        self.assertEqual(Path(row['payload']['local_media'][0]).read_text(encoding='utf-8'), 'FICTIONAL_MATERIAL_caption')
        self.assertEqual(len(self.runtime.store.materials('fictional-user')['files']), 1)

    async def test_quoted_target_is_kept_while_model_only_selects_material_use(self):
        self.decisions.append(proposal(title='虚构指定PPT'))
        await self.accept(self.event('task'))
        row = self.runtime.store.claim()
        await self.runtime.execute(row)
        tid = row['task_id']
        self.runtime.store.bind('fictional-user', 'fictional-card', tid)
        upload = self.upload('photo', '虚构照片.png')
        upload.reply_to = 'fictional-card'
        await self.accept(upload)
        self.assertIsNone(self.runtime.store.claim())
        self.decisions.append(proposal(title='模型不能新建的虚构任务', use_materials=True))
        await self.accept(self.event('prompt', '把上面的虚构照片加进去', reply='fictional-card'))
        selected = self.runtime.store.claim()
        self.assertEqual(selected['task_id'], tid)
        self.assertEqual(self.classifications[-1]['forced_task_id'], tid)
        self.assertEqual(len(selected['payload']['local_media']), 1)
        self.assertEqual(len(self.runtime.store.context('fictional-user')['tasks']), 1)

    async def test_download_delay_holds_followup_but_other_task_can_execute(self):
        gate = asyncio.Event()
        original_stage = self.runtime.stage_media
        async def delayed(row):
            if row['payload'].get('media_only'):
                await gate.wait()
            return await original_stage(row)
        self.runtime.stage_media = delayed
        self.runtime.start()
        await self.runtime.accept(self.upload('photo', '虚构慢照片.png'))
        self.decisions.append(proposal(use_materials=True))
        await self.runtime.accept(self.event('prompt', '用这些照片做虚构课件'))
        tid = self.runtime.store.context('fictional-user')['focus']
        self.decisions.append(proposal('resume', tid))
        await self.runtime.accept(self.event('follow', '虚构课件做15页'))
        await self.runtime.accept(self.event('status', '/tasks'))
        self.assertIn('正在保存素材，尚未开始', self.sent[-1][1])
        self.decisions.append(proposal(title='虚构独立生活问题', use_materials=False))
        await self.runtime.accept(self.event('life', '虚构晚餐问题'))
        await self.wait_for(lambda: len(self.runs) == 1)
        self.assertEqual(self.runs[0][1], '虚构晚餐问题')
        gate.set()
        await self.wait_for(lambda: len(self.runs) == 3)
        self.assertEqual([r[1] for r in self.runs[1:]], ['用这些照片做虚构课件', '虚构课件做15页'])
        self.assertEqual(len(self.runs[1][2]), 1)
        self.assertEqual(self.runs[2][2], [])

    async def test_restart_uses_saved_batch_even_if_original_is_gone(self):
        upload = self.upload('photo', '虚构已保存照片.png')
        await self.accept(upload)
        Path(upload.media_urls[0]).unlink()
        await self.runtime.stop()
        self.runtime = TaskRuntime(self.router, self.gateway)
        self.decisions.append(proposal(use_materials=True))
        await self.accept(self.event('prompt', '用刚上传的虚构图片做PPT'))
        row = self.runtime.store.claim()
        self.assertEqual(Path(row['payload']['local_media'][0]).read_text(encoding='utf-8'), 'FICTIONAL_MATERIAL_photo')

    async def test_restart_resumes_interrupted_batch_and_prompt_intake(self):
        upload = self.upload('photo', '虚构待保存照片.png')
        gate = asyncio.Event()
        original_stage = self.runtime.stage_media
        async def delayed(row):
            await gate.wait()
            return await original_stage(row)
        self.runtime.stage_media = delayed
        await self.runtime.accept(upload)
        self.decisions.append(proposal(use_materials=True))
        await self.runtime.accept(self.event('prompt', '用这些照片做虚构PPT'))
        native = self.runtime.native_turn
        await self.runtime.stop()
        self.runtime = TaskRuntime(self.router, self.gateway)
        self.runtime.native_turn = native
        self.runtime.start()
        await self.wait_for(lambda: all(r['state'] == 'material_ready'
            for r in self.runtime.store.material_rows('fictional-user',
                self.runtime.store.message(1)['payload']['material_batch_id'])))
        await self.wait_for(lambda: self.runtime.store.message(2)['state'] == 'done')
        self.assertEqual(len(self.runs), 1)
        self.assertEqual(Path(self.runs[0][2][0]).read_text(encoding='utf-8'), 'FICTIONAL_MATERIAL_photo')
        self.assertEqual(len(self.runtime.store.context('fictional-user')['tasks']), 1)

    async def test_failed_download_preserves_request_and_recovers_after_retry(self):
        upload = self.upload('photo', '虚构暂不可读照片.png')
        path = Path(upload.media_urls[0])
        path.unlink()
        await self.accept(upload)
        self.assertEqual(self.runtime.store.message(1)['state'], 'material_failed')
        self.decisions.append(proposal(use_materials=True))
        await self.accept(self.event('prompt', '用这些虚构照片做15页PPT'))
        tid = self.runtime.store.context('fictional-user')['focus']
        self.assertIsNone(self.runtime.store.claim())
        self.assertEqual(self.runtime.store.context('fictional-user')['pending']['text'], '用这些虚构照片做15页PPT')
        self.assertIsNotNone(self.runtime.store.materials('fictional-user'))
        path.write_text('FICTIONAL_RECOVERED_PHOTO', encoding='utf-8')
        self.decisions.append(proposal('resume', tid, resolves_pending=True, use_materials=True))
        await self.accept(self.event('retry', '继续使用这些素材'))
        row = self.runtime.store.claim()
        self.assertIn('15页PPT', row['payload']['text'])
        self.assertEqual(Path(row['payload']['local_media'][0]).read_text(encoding='utf-8'), 'FICTIONAL_RECOVERED_PHOTO')
        self.assertEqual(row['task_id'], tid)

    async def test_retry_precedes_queued_followup_and_does_not_take_later_batch(self):
        upload = self.upload('old', '虚构第一批.png')
        original_stage = self.runtime.stage_media
        gate = asyncio.Event()
        async def delayed(row):
            if row['payload'].get('media_only') and row['message_id'] == 'old':
                await gate.wait()
            return await original_stage(row)
        self.runtime.stage_media = delayed
        await self.runtime.accept(upload)
        self.decisions.append(proposal(use_materials=True))
        await self.runtime.accept(self.event('prompt', '根据上面的虚构图片做课件'))
        tid = self.runtime.store.context('fictional-user')['focus']
        self.decisions.append(proposal('resume', tid))
        await self.runtime.accept(self.event('follow', '虚构课件页数改成15页'))
        await self.runtime.accept(self.upload('new', '虚构另一批.png'))
        new_bid = self.runtime.store.materials('fictional-user')['id']
        Path(upload.media_urls[0]).unlink()
        gate.set()
        async with asyncio.timeout(8):
            await asyncio.gather(*self.runtime.intakes)
        self.assertIsNone(self.runtime.store.claim())
        Path(upload.media_urls[0]).write_text('FICTIONAL_FIRST_BATCH_RETRY', encoding='utf-8')
        self.decisions.append(proposal('resume', tid, resolves_pending=True, use_materials=True))
        await self.accept(self.event('retry', '继续使用原来那批素材'))
        first = self.runtime.store.claim()
        self.assertEqual(first['message_id'], 'retry')
        self.assertEqual([Path(p).read_text(encoding='utf-8') for p in first['payload']['local_media']],
                         ['FICTIONAL_FIRST_BATCH_RETRY'])
        self.assertEqual(self.runtime.store.materials('fictional-user')['id'], new_bid)
        await self.runtime.execute(first)
        follow = self.runtime.store.claim()
        self.assertEqual(follow['message_id'], 'follow')

    async def test_text_reply_without_delivery_confirmation_is_retryable_failure(self):
        self.decisions.append(proposal())
        await self.accept(self.event('task'))
        row = self.runtime.store.claim()
        async def unconfirmed(*args):
            return  # An accepted call alone cannot be a confirmed reply.
        old_deliver = self.router.deliver
        self.router.deliver = unconfirmed
        with self.assertLogs('fictional-task-tests', level='ERROR'):
            await self.runtime.execute(row)
        self.assertEqual(self.runtime.store.message(row['seq'])['state'], 'delivery_failed')
        self.assertEqual(len(self.runs), 1)
        self.router.deliver = old_deliver
        self.decisions.append(proposal('retry_delivery', row['task_id']))
        await self.accept(self.event('retry', '重发'))
        await self.runtime.execute(self.runtime.store.claim())
        self.assertEqual(self.runtime.store.message(row['seq'])['state'], 'done')
        self.assertEqual(len(self.runs), 1)

    async def test_reset_and_status_leave_running_tasks_alone(self):
        self.decisions.append(proposal())
        await self.accept(self.event('a'))
        row = self.runtime.store.claim()
        await self.accept(self.event('b', '/new'))
        self.assertIsNone(self.runtime.store.context('fictional-user')['focus'])
        self.assertEqual(self.runtime.store.message(row['seq'])['state'], 'running')
        await self.accept(self.event('c', '/tasks'))
        self.assertIn('正在处理', self.sent[-1][1])

    async def test_hot_reload_reuses_runtime_locks_and_workers(self):
        self.gateway._teacher_task_router = self.runtime
        self.decisions.append(proposal())
        result = await route(self.router, self.event('a'), self.gateway)
        self.assertIs(self.gateway._teacher_task_router, self.runtime)
        self.assertEqual(result['action'], 'skip')


class InstallerTests(unittest.TestCase):
    def test_patch_keeps_desktop_and_non_dingtalk_route_unchanged_and_is_idempotent(self):
        with tempfile.TemporaryDirectory(prefix='fictional-router-install-') as tmp:
            root = Path(tmp)
            original = """# teaching_video
async def route(event, gateway, **kwargs):
    global GATEWAY
    source = event.source
    if not gateway._is_user_authorized_for_source(source):
        return
    command = event.text
    if command.startswith('/') and command not in ('/new', '/reset'):
        return
    GATEWAY = gateway
    key = identity(source)
    async with LOCKS.setdefault(key, asyncio.Lock()):
        return 'legacy-route'
"""
            (root/'__init__.py').write_text(original, encoding='utf-8')
            (root/'main_courseware.py').write_text('# DELIVERY.file_receipt DELIVERY.watch', encoding='utf-8')
            source = Path(__file__).resolve().parents[1]/'workbench'
            changed = prepare(root, source)
            self.assertEqual(set(changed), {'__init__.py','gateway_tasks.py','gateway_task_runner.py'})
            body = changed['__init__.py']
            self.assertLess(body.index('_is_user_authorized_for_source'), body.index('gateway_tasks.route'))
            self.assertIn("if source.platform.value == 'dingtalk':", body)
            self.assertIn("return 'legacy-route'", body)
            (root/'__init__.py').write_text(body, encoding='utf-8')
            self.assertEqual(prepare(root, source), changed)
            (root/'main_courseware.py').write_text('# missing delivery extension', encoding='utf-8')
            with self.assertRaises(RuntimeError):
                prepare(root, source)


if __name__ == '__main__':
    unittest.main()
