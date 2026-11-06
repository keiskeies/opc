import { DatabaseSync } from "node:sqlite";
import { AsyncLocalStorage } from "node:async_hooks";
const db = new DatabaseSync(":memory:");
db.exec("CREATE TABLE t(a INTEGER, b INTEGER)");
function tryBind(n) {
  const sql = "INSERT INTO t VALUES " + Array.from({length:n}, () => "(?,?)").join(",");
  const vals = []; for (let i=0;i<n*2;i++) vals.push(i);
  try { db.prepare(sql).run(...vals); return true; } catch(e) { return false; }
}
let lo=1, hi=4096, best=0;
while (lo<=hi) { const mid=(lo+hi)>>1; if (tryBind(mid)) { best=mid; lo=mid+1; } else hi=mid-1; }
console.log("BIND_LIMIT_ROWS", best, "=> params", best*2);
function tryCols(n) {
  try { const sql="CREATE TABLE c"+n+" ("+Array.from({length:n},(_,i)=>"c"+i).join(",")+")"; db.exec(sql); return true; } catch { return false; }
}
console.log("COL_LIMIT_1000", tryCols(1000));
const als = new AsyncLocalStorage();
let seen = [];
function inner() {
  const conn = als.getStore();
  seen.push(!!conn);
  return conn;
}
async function middle() { await Promise.resolve(); await new Promise(r=>setTimeout(r,1)); return inner(); }
async function deep() { await Promise.resolve(); return middle(); }
await als.run(db, async () => {
  const a = await deep();
  // 模拟"框架内部"再套一层并发调度
  const [b, c] = await Promise.all([deep(), deep()]);
  seen.push(a===db, b===db, c===db);
});
console.log("ALS_SAME_CONNECTION_ACROSS_AWAITS", JSON.stringify(seen));
let nested = [];
await als.run("CONN-X", async () => {
  await Promise.all([
    (async () => { await null; nested.push(als.getStore()); })(),
    (async () => { await null; await null; nested.push(als.getStore()); })(),
  ]);
});
console.log("ALS_IN_CONCURRENT_CHILDREN", JSON.stringify(nested));
db.close();