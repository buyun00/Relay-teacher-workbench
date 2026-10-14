"""Fictional mathematical content; no production question bank fixtures."""
import json
import tempfile
import unittest
from pathlib import Path
from workbench.config import Config, WorkbenchError
from workbench.storage import Store
from workbench.question_bank import QuestionBank
from workbench.question_desktop import command


class LatexQuestionCase(unittest.TestCase):
    def test_edit_options_render_and_invalidate_check_preserving_source(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder);store=Store(Config(root=root/'store'));bank=QuestionBank(store)
            p=root/'fictional.json';p.write_text(json.dumps({'items':[{'stem':'Fictional $x^2=4$', 'answer':'A','analysis':'Fictional source','options':[{'label':'A','text':'$x=2$'},{'label':'B','text':'$x=-2$'}]}]}))
            bank.import_file(str(p));item=bank.search()['items'][0]
            original=bank.read(item['id'])
            clean=bank.revise(item['id'],1,{'format':'latex','stem':'Fictional $x^2=4$',
                'cleaning':{'source_item_id':item['id'],'source_revision':1},
                'answer_check':{'status':'consistent','reason':'Fictional machine check'}},'fictional cleaning')
            self.assertIn('<math',clean['body']['stem_html'])
            self.assertIn('annotation',clean['body']['stem_html'])
            view=command(store,{'action':'read','item_id':item['id']})
            self.assertEqual(view['original'],original['body'])
            derived=bank.adapt(item['id'],2,{'options':[{'label':'A','text':'$x=3$'}]},'fictional edit')
            self.assertEqual(derived['body']['answer_check']['status'],'stale')
            self.assertIn('3',derived['body']['stem_html'])
            self.assertNotIn('<mi>B</mi>',derived['body']['stem_html'])
            self.assertEqual(bank.read(item['id'])['body']['answer_check']['status'],'consistent')
            paper=bank.compose('Fictional paper',[{'item_id':derived['id'],'revision':1}],'Fictional test')
            student=Path(paper['files']['student.html']).read_text(encoding='utf-8')
            self.assertIn('<math',student);self.assertNotIn('<h3>答案</h3>',student)
            with self.assertRaises(WorkbenchError): bank.revise(derived['id'],1,{'stem':'Bad $\\notARealMacro{a}$'},'fictional invalid')
            self.assertEqual(bank.read(derived['id'])['revision'],1)
            bank.revise(derived['id'],1,{'answer':'B'},'fictional correction')
            self.assertTrue(bank.paper(paper['id'])['stale'])

    def test_no_network_or_trusted_tex_and_no_duplicate_choices(self):
        for value in ('$x', '$\\notARealMacro{a}$'):
            with self.assertRaises(WorkbenchError): QuestionBank.body({'format':'latex','stem':value})
        body=QuestionBank.body({'format':'latex','stem':'$\\includegraphics{https://example.com/x}$'})
        self.assertNotIn('<img',body['stem_html'])
        with self.assertRaises(WorkbenchError): QuestionBank.body({'stem':'Fictional','options':[{'label':'A','text':'1'},{'label':'A','text':'2'}]})
