const fs = require('fs');
const lines = fs.readFileSync('/tmp/douyin-cookies.txt','utf8').split('\n');
for (const line of lines) {
  if (line.startsWith('#') || !line.trim()) continue;
  const p = line.split('\t');
  if (!p[0] || !p[0].includes('douyin')) continue;
  const exp = parseInt(p[4]);
  if (!(exp > 0)) console.log('异常 expires:', JSON.stringify(p[4]), '| name:', p[5]);
}
