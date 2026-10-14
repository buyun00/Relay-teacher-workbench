"""All records in this suite are explicitly fictional."""
import json
import tempfile
import unittest
from pathlib import Path

from workbench.config import Config, WorkbenchError
from workbench.service import Workbench
from workbench.question_bank import QuestionBank


class QuestionBankCase(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory()
        self.w=Workbench(Config(root=Path(self.temp.name)/'store'))
        self.q=QuestionBank(self.w.store)
        self.source=Path(self.temp.name)/'fictional.json'
        self.source.write_text(json.dumps({'title':'虚构试题','items':[
            {'stem':'虚构：求 x² 在 [1,2] 的最小值','answer':'1','analysis':'递增，取左端点。','tags':['二次函数'],'kind':'解答'},
            {'stem':'虚构：计算 1+1','answer':'2','tags':['运算'],'kind':'填空'}]},ensure_ascii=False),encoding='utf-8')
        self.batch=self.call('import',path=str(self.source),expected_count=2)
        self.item=self.call('search',query='最小值')['items'][0]

    def tearDown(self): self.temp.cleanup()
    def call(self,action,**args): return self.w.invoke('teacher_question_bank',{'action':action,**args})
    def paper(self,item=None):
        item=item or self.item
        return self.call('compose',title='虚构个人练习',purpose='验证端点判断',selections=[
            {'item_id':item['id'],'revision':item['revision'],'task':{'instruction':'只判断在哪一端取最小值','hint':'先确定顶点位置'}}])

    def test_import_idempotent_and_count_mismatch_is_not_success(self):
        self.assertTrue(self.call('import',path=str(self.source))['duplicate'])
        self.assertEqual(self.call('search')['total'],2)
        with self.assertRaises(WorkbenchError): self.call('import',path=str(self.source),expected_count=150)

    def test_revision_preserves_original_and_invalidates_paper(self):
        p=self.paper()
        self.call('revise',item_id=self.item['id'],expected_revision=1,changes={'answer':'1（x=1 时）'},reason='虚构教师补充')
        self.assertEqual(self.call('read',item_id=self.item['id'],revision=1)['body']['answer'],'1')
        self.assertTrue(self.call('paper',paper_id=p['id'])['stale'])
        self.assertEqual(json.loads(Path(p['files']['manifest.json']).read_text(encoding='utf-8'))['items'][0]['revision'],1)
        with self.assertRaises(WorkbenchError): self.paper()
        with self.assertRaises(WorkbenchError): self.call('revise',item_id=self.item['id'],expected_revision=1,changes={'answer':'9'},reason='stale')

    def test_adaptation_parent_update_invalidates_descendant(self):
        child=self.call('adapt',item_id=self.item['id'],expected_revision=1,changes={'stem':'虚构：指出最小值所在端点'},reason='减少任务')
        self.assertEqual(child['parent_id'],self.item['id'])
        p=self.paper(child)
        self.call('revise',item_id=self.item['id'],expected_revision=1,changes={'tags':['二次函数','端点']},reason='更正标签')
        self.assertTrue(self.call('paper',paper_id=p['id'])['stale'])
        with self.assertRaises(WorkbenchError): self.paper(child)

    def test_personal_task_and_attempt_do_not_infer_mastery(self):
        p=self.paper()
        self.assertTrue(p['available'])
        student=Path(p['files']['student.html']).read_text(encoding='utf-8')
        teacher=Path(p['files']['teacher.html']).read_text(encoding='utf-8')
        self.assertNotIn('递增，取左端点。',student)
        self.assertIn('递增，取左端点。',teacher)
        a=self.call('attempt',paper_id=p['id'],position=1,response='左端点',assistance={'hint_shown':True})
        self.assertTrue(a['persisted']); self.assertFalse(a['mastery_inferred'])
        with self.assertRaises(WorkbenchError): self.call('compose',title='bad',purpose='test',student_id='unknown',selections=[{'item_id':self.item['id'],'revision':1}])

    def test_bad_import_is_atomic(self):
        self.source.write_text(json.dumps({'items':[{'stem':'虚构有效题'},{'stem':''}]}),encoding='utf-8')
        with self.assertRaises(WorkbenchError): self.call('import',path=str(self.source))
        self.assertEqual(self.call('search')['total'],2)

    def test_source_identity_deduplicates_across_batches_without_losing_revision(self):
        data={'items':[{'stem':'虚构同源题','answer':'1','source':{'provider':'fictional','question_id':'one'}}]}
        self.source.write_text(json.dumps(data),encoding='utf-8')
        first=self.call('import',path=str(self.source))
        item=self.call('search',batch_id=first['batch_id'])['items'][0]
        self.call('revise',item_id=item['id'],expected_revision=1,changes={'analysis':'虚构教师补充'},reason='补充')
        data['title']='另一次虚构组卷'
        self.source.write_text(json.dumps(data),encoding='utf-8')
        second=self.call('import',path=str(self.source))
        again=self.call('search',batch_id=second['batch_id'])['items'][0]
        self.assertEqual(again['id'],item['id']); self.assertEqual(again['revision'],2)

    def test_render_removes_executable_markup_but_preserves_math(self):
        child=self.call('adapt',item_id=self.item['id'],expected_revision=1,reason='虚构渲染测试',changes={
            'stem_html':'<p onclick="alert(1)">虚构<math><msup><mi>x</mi><mn>2</mn></msup></math></p><script>secret()</script><img src="https://example.invalid/a">'})
        p=self.paper(child)
        rendered=Path(p['files']['student.html']).read_text(encoding='utf-8')
        self.assertIn('<msup>',rendered)
        for bad in ('onclick','secret()','example.invalid'): self.assertNotIn(bad,rendered)

    def test_docx_teacher_sections_and_fraction(self):
        import zipfile
        source=Path(self.temp.name)/'fictional.docx'
        xml='''<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math"><w:body>
        <w:p><w:r><w:t>1. 虚构分数题</w:t></w:r><m:oMath><m:f><m:num><m:r><m:t>1</m:t></m:r></m:num><m:den><m:r><m:t>2</m:t></m:r></m:den></m:f></m:oMath></w:p>
        <w:p><w:r><w:t>【答案】0.5</w:t></w:r></w:p><w:p><w:r><w:t>【解析】分子除以分母</w:t></w:r></w:p>
        </w:body></w:document>'''
        with zipfile.ZipFile(source,'w') as z: z.writestr('word/document.xml',xml)
        batch=self.call('import',path=str(source),expected_count=1)
        item=self.call('search',batch_id=batch['batch_id'])['items'][0]
        body=self.call('read',item_id=item['id'])['body']
        self.assertIn('<mfrac>',body['stem_html']); self.assertIn('0.5',body['answer'])
        self.assertNotIn('0.5',body['stem']); self.assertIn('分子除以分母',body['analysis'])

    def test_native_surface(self):
        from workbench.native import register_plugin
        class Context:
            def __init__(self): self.tools={}
            def register_tool(self,**kw): self.tools[kw['name']]=kw
            def register_skill(self,*a,**kw): pass
            def register_system_prompt_section(self,*a,**kw): pass
            def register_hook(self,*a,**kw): pass
        ctx=Context(); register_plugin(ctx,self.w)
        result=json.loads(ctx.tools['teacher_question_bank']['handler']({'action':'search','query':'最小值'}))
        self.assertTrue(result['ok']); self.assertEqual(result['result']['total'],1)

    def test_backup_restore_includes_bank(self):
        from workbench.storage import Store
        p=self.paper(); backup=self.w.store.backup()
        dest=Path(self.temp.name)/'restored'
        Store.restore(Path(backup['path']),dest)
        q=QuestionBank(Store(Config(root=dest)))
        self.assertEqual(q.search()['total'],2)
        self.assertTrue(q.paper(p['id'])['available'])

if __name__=='__main__': unittest.main()
