// 改 chip 之前，把 PAIRS 里【没列】但源码上真实存在的 chip 落点也算一遍：
// nav a.admin-act(admin.css:86) 与 pre(148) 都是 background:var(--chip) + color:var(--ink)，
// 而 admin-light 的 ink 那行只列了 card/bg —— 换底会动到它，不能当它不存在。
const lum = (h) => { const c=[1,3,5].map(i=>parseInt(h.slice(i,i+2),16)/255).map(v=>v<=0.03928?v/12.92:((v+0.055)/1.055)**2.4); return 0.2126*c[0]+0.7152*c[1]+0.0722*c[2]; };
const cr = (a,b) => { const [x,y]=[lum(a),lum(b)].sort((p,q)=>q-p); return Math.round(((x+0.05)/(y+0.05))*100)/100; };
const L = { ink:"#202735", muted:"#616c7b", amber:"#9d630f", err:"#c74848", oldChip:"#f3f5f8", newChip:"#e9edf3", bg:"#f3f5f8", card:"#ffffff" };
const D = { ink:"#e6e9f0", muted:"#9aa4b8", err:"#e26a6a", pillRed:"#d98a8a", oldChip:"#232834", newChip:"#2a303d", bg:"#14171e", card:"#1c2029" };
console.log("浅色（ink/amber/err 压在 chip 上的真实规则：nav a.admin-act、pre、.admin-tag）");
for (const k of ["ink","muted","amber","err"]) {
  console.log(`  ${k.padEnd(6)} ${L[k]}  旧chip ${cr(L[k],L.oldChip)} → 新chip ${cr(L[k],L.newChip)}  (card ${cr(L[k],L.card)} / bg ${cr(L[k],L.bg)})`);
}
console.log("暗色（对齐 #2a303d 后）");
for (const k of ["ink","muted","err","pillRed"]) {
  console.log(`  ${k.padEnd(6)} ${D[k]}  旧chip ${cr(D[k],D.oldChip)} → 新chip ${cr(D[k],D.newChip)}  (card ${cr(D[k],D.card)} / bg ${cr(D[k],D.bg)})`);
}
// 新灰（暗色 chip 变浅后 gray 要提亮）
console.log(`  gray   #66718a 旧chip ${cr("#66718a",D.oldChip)} → 新chip ${cr("#66718a",D.newChip)}（ui≥3.0）`);
console.log(`  gray'  #6f7b95 新chip ${cr("#6f7b95",D.newChip)} · card ${cr("#6f7b95",D.card)} · bg ${cr("#6f7b95",D.bg)}`);
