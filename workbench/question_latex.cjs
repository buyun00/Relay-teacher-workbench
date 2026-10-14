// Offline MathML rendering; no network or executable TeX commands.
const katex = require('./vendor/katex.cjs');
const fs = require('node:fs');
const escape = s => s.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
function render(text) {
  text = text.replace(/\\\[([\s\S]*?)\\\]/g, (_,v) => '$$'+v+'$$').replace(/\\\(([\s\S]*?)\\\)/g, (_,v) => '$'+v+'$');
  const pattern = /\$\$([\s\S]*?)\$\$|\$([^$]*?)\$/g;
  let result = '', at = 0, match;
  while ((match = pattern.exec(text))) {
    const literal = text.slice(at, match.index);
    if (literal.includes('$')) throw Error('公式分隔符不配对');
    result += escape(literal).replaceAll('\n','<br>');
    result += katex.renderToString(match[1] ?? match[2], {output:'mathml',displayMode:match[1] !== undefined,throwOnError:true,strict:'ignore',trust:false});
    at = pattern.lastIndex;
  }
  if (text.slice(at).includes('$')) throw Error('公式分隔符不配对');
  return result + escape(text.slice(at)).replaceAll('\n','<br>');
}
try {
  const values=JSON.parse(fs.readFileSync(0,'utf8'));
  console.log(JSON.stringify(values.map(value => {
    if (!process.argv.includes('--audit')) return render(value);
    try { render(value); return {ok:true}; } catch(e) { return {ok:false,error:e.message}; }
  })));
}
catch (e) { console.error(e.message); process.exitCode=1; }
