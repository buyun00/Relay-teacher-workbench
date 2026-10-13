"""Opt-in real DeepSeek + Hermes smoke in a FICTIONAL, isolated profile.

Not part of unittest discovery. Never sends a DingTalk message. Credentials
come from the caller's environment; no credential is written into the fixture.
"""
import argparse
import asyncio
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
from types import SimpleNamespace


async def hook_smoke(router, root):
    from gateway.config import Platform
    from gateway.session import SessionSource
    from gateway.platforms.event import MessageEvent
    deliveries = []
    async def send(*args, **kwargs):
        raise AssertionError('Legacy shared adapter must not send these task replies')
    async def deliver(job, text, finished=False):
        deliveries.append((job['source']['chat_id'], text))
        job['card_created'] = True
    classification_calls = []
    async def ask(prompt, context):
        classification_calls.append(context)
        return {'action':'new','title':'虚构独立任务','confidence':1,
                'use_materials': '上面' in context['message']}
    async def classify(*args):
        return {'workflow':'chat','engine':'deepseek','new_topic':True,'gpt_preset':'sol_xhigh'}
    adapter = SimpleNamespace(send=send, _client_id='fictional-robot')
    gateway = SimpleNamespace(_delivery_adapter_for=lambda source:adapter,
                              _is_user_authorized_for_source=lambda source:True)
    router.deliver, router.ask_json, router.classify = deliver, ask, classify
    source=SessionSource(platform=Platform.DINGTALK, chat_id='fictional-chat', chat_type='dm',
                         user_id='fictional-user', user_id_alt='fictional-staff')
    first=await router.route(MessageEvent(text='虚构PPT任务',source=source,message_id='fictional-hook-a'),gateway)
    runtime=gateway._teacher_task_router
    async def native(row,task,settings,paths):
        await asyncio.sleep(.1)
        return {'text':row['payload']['text'],'files':[],'session_id':'fictional-'+task['id']}
    runtime.native_turn=native
    try:
        second=await router.route(MessageEvent(text='虚构晚餐任务',source=source,message_id='fictional-hook-b'),gateway)
        assert first['action']==second['action']=='skip'
        async with asyncio.timeout(8):
            while True:
                with runtime.store.db() as db:
                    done=db.execute("SELECT COUNT(*) FROM inbox WHERE state='done'").fetchone()[0]
                if done==2:break
                await asyncio.sleep(.05)
        tasks=runtime.store.context(router.identity(source))['tasks']
        assert len(tasks)==2 and tasks[0]['id']!=tasks[1]['id']
        assert all(cid=='fictional-chat' for cid,_ in deliveries)
        await batch_hook_smoke(router, gateway, source, runtime, root, classification_calls)
        result={'native_MessageEvent_hook':True,'isolated_task_dispatch':True,
                'burst_material_batch_hook':True,'external_messages_sent':False}
        (root/'hook-evidence.json').write_text(json.dumps(result))
        print('HOOK_EVIDENCE',json.dumps(result),flush=True)
    finally:
        await runtime.stop()


async def batch_hook_smoke(router, gateway, source, runtime, root, classification_calls):
    from gateway.platforms.event import MessageEvent
    received = []
    async def native(row, task, settings, paths):
        received.append({'task': task['id'], 'text': row['payload']['text'],
                         'names': [Path(p).name for p in paths],
                         'content': [Path(p).read_text() for p in paths]})
        return {'text': '虚构批次验收完成', 'files': [], 'session_id': 'fictional-' + task['id']}
    runtime.native_turn = native
    owner = router.identity(source)
    before = len(classification_calls)
    before_tasks = len(runtime.store.context(owner)['tasks'])
    # Parse actual SDK file payloads: their '[文件] name' fallback is not a prompt.
    from dingtalk_stream import ChatbotMessage
    from plugins.platforms.dingtalk.inbound import extract_text
    for i, name in enumerate(['虚构图片一.png', '虚构图片二.png', '虚构资料.pdf']):
        path = root / ('fictional-material-' + str(i))
        path.write_text('FICTIONAL_BATCH_' + str(i))
        raw = ChatbotMessage.from_dict({'msgtype': 'file', 'content': {'fileName': name,
                                       'downloadCode': 'fictional-code-' + str(i)}})
        result = await router.route(MessageEvent(text=extract_text(raw), source=source,
            raw_message=raw, media_urls=[str(path)], message_id='fictional-upload-' + str(i)), gateway)
        assert result['action'] == 'skip'
    async with asyncio.timeout(10):
        while any(f['state'] != 'material_ready' for f in runtime.store.materials(owner)['files']):
            await asyncio.sleep(.05)
    assert len(classification_calls) == before
    assert len(runtime.store.context(owner)['tasks']) == before_tasks
    assert received == []
    await router.route(MessageEvent(text='虚构晚餐怎么做？', source=source,
                       message_id='fictional-batch-life'), gateway)
    async with asyncio.timeout(10):
        while len(received) < 1:
            await asyncio.sleep(.05)
    assert received[0]['content'] == []
    assert len(runtime.store.materials(owner)['files']) == 3
    await router.route(MessageEvent(text='根据上面的虚构图片和资料做PPT', source=source,
                       message_id='fictional-batch-prompt'), gateway)
    async with asyncio.timeout(10):
        while len(received) < 2:
            await asyncio.sleep(.05)
    assert received[1]['content'] == ['FICTIONAL_BATCH_0', 'FICTIONAL_BATCH_1', 'FICTIONAL_BATCH_2']
    assert [Path(p).suffix for p in received[1]['names']] == ['.png', '.png', '.pdf']
    assert runtime.store.materials(owner) is None
    evidence = {'real_Hermes_MessageEvent': True, 'real_DingTalk_SDK_parser': True,
                'no_routing_before_prompt': True, 'life_question_keeps_materials': True,
                'one_prompt_receives_full_batch': True, 'filenames_preserved': True,
                'external_messages_sent': False}
    (root / 'material-hook-evidence.json').write_text(json.dumps(evidence, indent=2))
    print('MATERIAL_HOOK_EVIDENCE', json.dumps(evidence), flush=True)


async def main(candidate, root, hook_only=False):
    assert 'fictional' in root.name
    root.mkdir(parents=True, exist_ok=True)
    from dotenv import load_dotenv
    load_dotenv('/opt/data/.env', override=False)
    # Existing shared courseware code is a library, not validation task state.
    sys.path.insert(0, '/opt/data/courseware-lib')
    os.environ['HERMES_HOME'] = str(root)
    (root/'config.yaml').write_text('''model:
  default: deepseek-flash
  provider: deepseek
terminal:
  backend: local
  cwd: ''' + str(root) + '''
platform_toolsets:
  cli: [terminal, file]
agent:
  max_turns: 8
plugins:
  enabled: []
''')
    spec = importlib.util.spec_from_file_location('fictional_candidate_router', candidate/'__init__.py',
                                                 submodule_search_locations=[str(candidate)])
    router = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = router
    spec.loader.exec_module(router)
    if hook_only:
        await hook_smoke(router,root)
        return
    from fictional_candidate_router.gateway_tasks import PROMPT
    tasks = [
        {'id':'fictional-ppt','title':'虚构函数第一课PPT','state':'running','last_user':'制作虚构函数PPT', 'last_answer':'希望做多少页？'},
        {'id':'fictional-image','title':'虚构生日贺卡','state':'running','last_user':'制作虚构贺卡', 'last_answer':'配色可继续调整。'},
        {'id':'fictional-dinner','title':'虚构晚餐讨论','state':'idle','last_user':'晚上吃什么', 'last_answer':'可以做青椒炒蛋。'}]
    cases = [
        ('生活问题不进入制作任务', '明天天气怎么样？', 'new', None),
        ('明确修改返回旧任务', '刚才函数第一课PPT第二页加一个例子', 'resume', 'fictional-ppt'),
        ('简短答复对应待回答问题', 'PPT做15页就好', 'resume', 'fictional-ppt'),
        ('多个成果指向歧义', '颜色再淡一点', 'clarify', None),
        ('独立视频创建任务', '另做一份虚构三角函数教学视频', 'new', None),
        ('完成通知不改变生活话题', '晚餐不要辣的', 'resume', 'fictional-dinner'),
        ('纯状态查询', '现在有哪些任务在做？', 'status', None),
    ]
    results = []
    for label, message, action, tid in cases:
        response = await router.ask_json(PROMPT, {'focus':'fictional-dinner', 'tasks':tasks,
            'pending':None, 'recent_user_messages':['晚上吃什么'], 'message':message,'attachments':[]})
        passed = response.get('action') == action and (tid is None or response.get('task_id') == tid)
        results.append({'case':label, 'passed':passed, 'proposal':response})
        print('DS_CASE', label, passed, flush=True)
    (root/'routing-evidence.json').write_text(json.dumps(results,ensure_ascii=False,indent=2))
    assert all(r['passed'] for r in results), 'Real classifier mismatch; inspect fictional evidence'

    material_batch = {'id': 'fictional-material-batch', 'files': [
        {'name': '虚构图片一.png', 'state': 'material_ready'},
        {'name': '虚构图片二.png', 'state': 'material_ready'}]}
    material_cases = [
        ('生活问题保留素材', '今晚晚餐不要辣的，怎么做？', 'resume', 'fictional-dinner', False, None),
        ('上传后明确新课件', '根据上面上传的两张虚构图片制作一份全新的指数函数PPT', 'new', None, True, None),
        ('旧PPT文字修改不用素材', '函数第一课PPT页数改成10页', 'resume', 'fictional-ppt', False, None),
        ('状态查询不取素材', '现在有哪些任务？', 'status', None, False, None),
        ('独立图片任务不用素材', '另外画一张全新的虚构猫咪插画，纯文字创作', 'new', None, False, None),
        ('素材用途不明确先澄清', '把这些虚构图片加进去', 'clarify', None, None, None),
        ('澄清答复恢复原素材要求', '是虚构函数第一课PPT', 'resume', 'fictional-ppt', True,
            {'text': '把这两张虚构图片加进去', 'attachments': [], 'material_batch': material_batch}),
    ]
    material_results = []
    for label, message, action, tid, use, pending in material_cases:
        response = await router.ask_json(PROMPT, {'focus': 'fictional-dinner', 'tasks': tasks,
            'pending': pending, 'material_batch': material_batch, 'message': message, 'attachments': [],
            'recent_user_messages': ['晚上吃什么']})
        passed = response.get('action') == action and (tid is None or response.get('task_id') == tid)
        passed = passed and (use is None or response.get('use_materials') is use)
        passed = passed and (pending is None or response.get('resolves_pending') is True)
        material_results.append({'case': label, 'passed': passed, 'proposal': response})
        print('DS_MATERIAL_CASE', label, passed, flush=True)
    (root / 'material-routing-evidence.json').write_text(json.dumps(material_results, ensure_ascii=False, indent=2))
    assert all(r['passed'] for r in material_results), 'Real material routing mismatch; inspect fictional evidence'

    # Execute two real native agents concurrently in separate cwd and SessionDB IDs.
    async def turn(tid, text, settings=None, index=1):
        work=root/tid
        work.mkdir(exist_ok=True)
        request=work/f'{index}.request.json'
        response=work/f'{index}.response.json'
        request.write_text(json.dumps({'task_id':tid,'turn_id':f'{tid}-{index}',
            'settings':settings or {'engine':'deepseek'}, 'message':text, 'attachments':[], 'work':str(work)},ensure_ascii=False))
        with (work/f'{index}.stderr').open('wb') as err:
            child=await asyncio.create_subprocess_exec(sys.executable,str(candidate/'gateway_task_runner.py'),
                '--request',str(request),'--response',str(response),stdout=asyncio.subprocess.DEVNULL,stderr=err,
                env={**os.environ,'PYTHONPATH':'/opt/hermes'})
            code=await child.wait()
        assert code == 0, f'Native child failed: {tid}'
        data=json.loads(response.read_text())
        assert data['state']=='completed', data['state']
        return data
    a,b=await asyncio.gather(
        turn('fictional-task-a','这是虚构验收。只记住本会话的暗号是 FICTIONAL_APPLE_7319，回复“已记录”。不要使用记忆工具，不要记录到全局记忆。'),
        turn('fictional-task-b','这是虚构验收。只记住本会话的暗号是 FICTIONAL_ORANGE_9264，回复“已记录”。不要使用记忆工具，不要记录到全局记忆。'))
    assert a['session_id'] != b['session_id']
    a2,b2=await asyncio.gather(
        turn('fictional-task-a','只回答本会话刚才的暗号。',{'engine':'deepseek','hermes_session':a['session_id']},2),
        turn('fictional-task-b','只回答本会话刚才的暗号。',{'engine':'deepseek','hermes_session':b['session_id']},2))
    assert 'FICTIONAL_APPLE_7319' in a2['text'] and 'ORANGE' not in a2['text'], a2['text']
    assert 'FICTIONAL_ORANGE_9264' in b2['text'] and 'APPLE' not in b2['text'], b2['text']
    tool=await turn('fictional-task-a','虚构工具验收：请用文件或终端工具在本轮指定成品目录创建 fictional.txt，内容严格为 FICTIONAL_FILE_7319，并附上这个文件。',
                    {'engine':'deepseek','hermes_session':a2['session_id']},3)
    assert tool['files'], 'Native tools did not create a file'
    assert any(Path(p).read_text().strip()=='FICTIONAL_FILE_7319' for p in tool['files'])
    evidence={'parallel_sessions_distinct':True,'resume_contexts_isolated':True,
              'native_file_tool_verified':True,'dingtalk_transport_tested':False}
    (root/'native-evidence.json').write_text(json.dumps(evidence,indent=2))
    print('NATIVE_EVIDENCE',json.dumps(evidence),flush=True)


if __name__=='__main__':
    parser=argparse.ArgumentParser()
    parser.add_argument('--candidate',type=Path,required=True)
    parser.add_argument('--root',type=Path,required=True)
    parser.add_argument('--hook-only',action='store_true')
    args=parser.parse_args()
    asyncio.run(main(args.candidate,args.root,args.hook_only))
