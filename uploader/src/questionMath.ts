import katex from 'katex';
const esc = (s: string) => s.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');
export function mathPreview(value: string): string {
  const pattern = /\$\$([\s\S]*?)\$\$|\$([^$]*?)\$/g;
  let out='', at=0;
  for(const m of value.matchAll(pattern)) {
    out+=esc(value.slice(at,m.index)).replaceAll('\n','<br>');
    try { out+=katex.renderToString(m[1]??m[2],{output:'mathml',displayMode:m[1]!==undefined,throwOnError:true,trust:false}); }
    catch { out+='<strong style="color:#a33">公式有误：'+esc(m[0])+'</strong>'; }
    at=m.index!+m[0].length;
  }
  return out+esc(value.slice(at)).replaceAll('\n','<br>');
}
export const answerCheckNames: Record<string,string> = {consistent:'机器核对一致 · 未经人工审核',mismatch:'答案或解析存在冲突',uncertain:'答案核对不确定',insufficient:'条件不全，无法核对',stale:'内容已修改，需重新核对',not_checked:'尚未核对'};
