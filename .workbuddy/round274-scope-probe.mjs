import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
const plan = readFileSync("docs/superpowers/plans/2026-11-06-opc-os-development-plan.md","utf8");
const have = new Set([...plan.matchAll(/^###\s+Task\s+([0-9]+\.[0-9]+[a-z]*)/gm)].map(m=>m[1]));
// walk 把结果【返回】给它自己那一份列表：上一版把两次 walk 都推进同一个模块级 files，
// 我又去扫两个从没被填过的空数组 ⇒ 三行读数全 0，而 0 看着像「没有引用」。
const walk=(dir,{skipPoc=false,ext=".ts"}={})=>{const out=[];
  for(const e of readdirSync(dir,{withFileTypes:true})){
    if(e.name==="node_modules") continue;
    if(skipPoc && e.name==="poc") continue;
    const p=join(dir,e.name);
    if(e.isDirectory()) out.push(...walk(p,{skipPoc,ext}));
    else if(e.name.endsWith(ext)) out.push(p);}
  return out;};
const scan=(list)=>{const refs=new Map();for(const f of list){for(const m of readFileSync(f,"utf8").matchAll(/Task ([0-9]+\.[0-9]+[a-z]*)/g)) refs.set(m[1],(refs.get(m[1])??0)+1);}return refs;};
const pick=(list,pref)=>list.filter(f=>pref.some((x)=>f.startsWith(x)));
const allTs=walk(".",{});
for (const [label,list] of [
  ["packages+test, skip poc", pick(walk(".",{skipPoc:true}),["packages","test"])],
  ["packages+test, incl poc", pick(allTs,["packages","test"])],
  ["全部 .ts incl poc", allTs]]) {
  const r=scan(list); const miss=[...r].filter(([k])=>!have.has(k)).sort((a,b)=>b[1]-a[1]);
  console.log(label.padEnd(26), "files="+String(list.length).padStart(4), "refs="+String([...r.values()].reduce((a,b)=>a+b,0)).padStart(4), "distinct="+String(r.size).padStart(3), "dangling="+miss.length, miss.slice(0,6).map(([k,n])=>k+"("+n+")").join(" "));
}
const md=walk("docs",{ext:".md"}).filter(f=>!f.includes("plans"));
const r=scan(md); const miss=[...r].filter(([k])=>!have.has(k)).sort((a,b)=>b[1]-a[1]);
console.log("docs/**/*.md (不含计划本身)".padEnd(26), "files="+String(md.length).padStart(4), "refs="+String([...r.values()].reduce((a,b)=>a+b,0)).padStart(4), "distinct="+String(r.size).padStart(3), "dangling="+miss.length, miss.map(([k,n])=>k+"("+n+")").join(" "));
console.log("计划标题数:",have.size,"| 计划文件在场:",existsSync("docs/superpowers/plans/2026-11-06-opc-os-development-plan.md"));
