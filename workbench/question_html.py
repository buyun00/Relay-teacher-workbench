"""Keep mathematical markup and embedded images, never executable source markup."""
from html import escape
from html.parser import HTMLParser

TAGS=set('p div span br table tbody thead tr td th b strong i em u sup sub ul ol li math mi mn mo mrow msup msub msubsup mfrac msqrt mroot mtable mtr mtd munder mover munderover mfenced mspace mtext menclose mpadded mstyle img'.split())
ATTRS=set('colspan rowspan width height display stretchy fence separator mathvariant mathsize notation lspace rspace accent accentunder open close separators'.split())

class SafeHTML(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.out=[]; self.skip=0
    def handle_starttag(self,tag,attrs):
        if tag in ('script','style','iframe','object'): self.skip+=1; return
        if self.skip or tag not in TAGS: return
        clean=[]
        for key,value in attrs:
            if key in ATTRS or (tag=='math' and key=='xmlns'):
                clean.append(f' {key}="{escape(value or "",quote=True)}"')
            if tag=='img' and key=='src' and (value or '').startswith(('data:image/png;base64,','data:image/jpeg;base64,','data:image/gif;base64,','data:image/webp;base64,')):
                clean.append(f' src="{escape(value,quote=True)}"')
            if tag=='img' and key=='alt': clean.append(f' alt="{escape(value or "",quote=True)}"')
        self.out.append('<'+tag+''.join(clean)+'>')
    def handle_endtag(self,tag):
        if tag in ('script','style','iframe','object'):
            self.skip=max(0,self.skip-1); return
        if not self.skip and tag in TAGS and tag not in ('br','img'): self.out.append('</'+tag+'>')
    def handle_data(self,data):
        if not self.skip: self.out.append(escape(data))

def sanitize(value):
    p=SafeHTML(); p.feed(value); return ''.join(p.out)
