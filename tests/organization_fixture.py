"""Seed ONLY isolated fictional E2E receiver roots after the real uploader transfers files."""
import json
import sys
from pathlib import Path

from workbench.config import Config
from workbench.service import Workbench
from workbench.organization import Organization


def seed(root):
    w = Workbench(Config(root=Path(root)))
    with w.store.transaction() as db:
        assets = [dict(r) for r in db.execute("SELECT * FROM assets WHERE kind='audio' ORDER BY filename")]
        if len(assets) != 2 or any(not a["filename"].startswith("fictional-") for a in assets):
            raise RuntimeError("Expected exactly two explicitly fictional uploaded audio fixtures")
        db.execute("INSERT INTO classes VALUES('fictional-c1','虚构高一（3）班',NULL)")
        db.execute("INSERT INTO students VALUES('fictional-s1','张明')")
        db.execute("INSERT INTO students VALUES('fictional-s2','李华')")
        db.executemany("INSERT INTO memberships VALUES('fictional-c1',?)", [("fictional-s1",),("fictional-s2",)])
    refs=[]
    for a in assets:
        w.facts.transcript(a["id"],"fictional-ASR-fixture",[
            {"start":600,"end":630,"text":"虚构教师：如何判断函数递增？","speaker":"SPEAKER_00"},
            {"start":900,"end":950,"text":"虚构学生：后面的函数值比前面大。","speaker":"SPEAKER_01"},
        ])
        with w.store.connect() as db:
            refs.append([{"kind":"segment","id":r["id"],"revision":r["revision"]} for r in db.execute("SELECT s.* FROM segments s JOIN transcripts t ON s.transcript_id=t.id WHERE t.asset_id=? ORDER BY position",(a["id"],))])
    Organization(w.store).propose([a["id"] for a in assets],[{"title":"虚构端到端函数课","kind":"class","events":[
        {"title":"虚构教师提问","detail":"教师提出函数问题。","sources":[refs[0][0]]},
        {"title":"虚构学生回答","detail":"匿名学生回应教师。","question":"这句话是哪位学生说的？","sources":[refs[0][1]]},
        {"title":"后续虚构原文","detail":"同一课堂后续片段。","sources":refs[1]},
    ]}])
    print(json.dumps({"fictional":True,"activities":1}))


if __name__ == "__main__": seed(sys.argv[1])
