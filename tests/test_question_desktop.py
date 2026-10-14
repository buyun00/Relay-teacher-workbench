"""HTTP authentication, persisted drafts and version conflicts with fictional data."""
import json
import tempfile
import threading
import unittest
from pathlib import Path
from urllib.request import Request, urlopen
from urllib.error import HTTPError
from workbench.config import Config
from workbench.storage import Store
from workbench.question_bank import QuestionBank
from workbench.ingress import DesktopIngress, IngressServer


class DesktopQuestionsCase(unittest.TestCase):
    def test_http_bank_and_stale_preview(self):
        with tempfile.TemporaryDirectory() as folder:
            store = Store(Config(root=Path(folder)/'store', workspace_id='fictional'))
            bank = QuestionBank(store)
            source=Path(folder)/'fictional.json'
            source.write_text(json.dumps({'items':[{'stem':'Fictional 1+1?', 'answer':'2','tags':['addition']}]}),encoding='utf-8')
            bank.import_file(str(source))
            server=IngressServer(('127.0.0.1',0),DesktopIngress(store),'fictional-token')
            thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
            endpoint=f'http://127.0.0.1:{server.server_port}/v1/question-bank'
            def call(action,**args):
                req=Request(endpoint,data=json.dumps({'workspace_id':'fictional','action':action,**args}).encode(),headers={'Authorization':'Bearer fictional-token'})
                with urlopen(req,timeout=5) as response: return json.load(response)
            try:
                with self.assertRaises(HTTPError) as caught: urlopen(Request(endpoint,data=b'{}'))
                self.assertEqual(caught.exception.code,401);caught.exception.close()
                self.assertEqual(call('catalog')['batches'][0]['item_count'],1)
                item=call('search')['items'][0]
                self.assertEqual(call('search',review_status='reviewed')['total'],0)
                paper=call('compose',title='Fictional draft',purpose='Fictional practice',selections=[{'item_id':item['id'],'revision':1}])
                preview=call('preview',paper_id=paper['id'])
                self.assertIn('Fictional 1+1?',preview['student_html'])
                self.assertNotIn('<h3>答案</h3>',preview['student_html'])
                self.assertIn('<h3>答案</h3>',preview['teacher_html'])
                call('revise',item_id=item['id'],expected_revision=1,changes={'review_status':'reviewed'},reason='Fictional check')
                self.assertEqual(call('search',review_status='reviewed')['total'],1)
                self.assertEqual(call('preview',paper_id=paper['id'])['stale'],1)
                with self.assertRaises(HTTPError) as caught: call('revise',item_id=item['id'],expected_revision=1,changes={'answer':'3'},reason='stale')
                self.assertEqual(caught.exception.code,409);caught.exception.close()
                with self.assertRaises(HTTPError) as caught: call('catalog',workspace_id='wrong')
                self.assertEqual(caught.exception.code,409);caught.exception.close()
            finally:
                server.shutdown();server.server_close();thread.join(5)
