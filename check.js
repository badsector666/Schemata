const fs = require("fs");
const html = fs.readFileSync("admin-ui v2.html", "utf8");
const m = html.match(/<script>([\s\S]*)<\/script>/);
const code = m[1];
const lines = code.split('\n');
let lo = 1, hi = 100;
while (lo < hi - 1) {
  const mid = Math.floor((lo+hi)/2);
  try { new Function(lines.slice(0, mid).join('\n')); lo = mid; }
  catch { hi = mid; }
}
console.log(`Error at line ${hi}:`);
for (let j = Math.max(0,hi-3); j <= Math.min(lines.length-1,hi+3); j++) {
  console.log(`${j+1}: ${lines[j]}`);
}
