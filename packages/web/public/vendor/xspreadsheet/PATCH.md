# vendor/xspreadsheet —— 我们改过上游字节（升级时必须重打）

- 上游：x-data-spreadsheet@1.1.9（npm，MIT，© 2017 myliang），最后一次发布 2023-07-29，**已无人维护**。
- 未打补丁的 xspreadsheet.js sha256：`f035f5ac9cbf7325a83461a81f6604fc6240ebc2633a620747944518da323f42`
- 打完补丁的 xspreadsheet.js sha256：`0f430141f5b9da88953e119162a22e44b465bb9f66cc0c7fa8b0d546df196b4e`
- `xspreadsheet.js.map` / `xspreadsheet.css.map` 故意不 vendor：改过字节后 source map 只会失真，
  末尾的 `//# sourceMappingURL=` 也一起剥掉，免得 devtools 里挂个 404。

## 改动一（承重）：未知公式不再炸画布

库的求值器把函数名查表后直接 `.render`：

```
g.push(i.pop());i.push(e[v].render(g.reverse()))
```

`e[v]` 对未知函数名是 `undefined`，抛 TypeError 的位置在 canvas 绘制循环内部，
**后果不是那一格报错，是整张网格画不出来** —— 用户把 `=SUM(` 打成 `=SMU(` 就砸掉整个编辑器。
改成查不到就落 `#ERROR!`（与本仓旧自研引擎的错误串一致）：

```
g.push(i.pop());i.push(e[v]?e[v].render(g.reverse()):"#ERROR!")
```

## 改动二：补 COUNT / ROUND，保住旧引擎的公式面

旧自研引擎支持 `SUM / AVERAGE / MIN / MAX / COUNT / ROUND`（group.js 里
`createSheetEvaluator`，round 带 `Number.EPSILON` 修正、digits 限 ±15 整数）；
上游只内置 `SUM / AVERAGE / MAX / MIN / IF / AND / OR / CONCAT`。
不补这两支，换库就等于悄悄少两个函数（顺带白得 IF/AND/OR/CONCAT）。
追加在公式表 `{key:"CONCAT",...}]` 之后：

```
{key:"CONCAT",title:U("formula.concat"),render:function(t){return t.join("")}},{key:"COUNT",title:"COUNT",render:function(t){return t.filter(function(e){var n=Number(e);return ""!==e&&!Number.isNaN(n)&&Number.isFinite(n)}).length}},{key:"ROUND",title:"ROUND",render:function(t){var e=Number(t[0]);var n=Number.isNaN(Number(t[1]))?0:Number(t[1]);return Number.isNaN(e)?0:Math.round((e+Number.EPSILON)*Math.pow(10,n))/Math.pow(10,n)}}]
```

`title` 用字面量而不是 `U("formula.count")`：zh-cn 语料里没有这两个键，
`U()` 查不到会返回空串，工具栏插入项就成了空白按钮。

## 改动三（承重）：SUM 遇文本格跳过，而不是拼出 NaN

上游的 SUM 是 `t.reduce((t,e)=>D("+",t,e),0)`，而 D 的加法支是
`if(Number.isNaN(e)||Number.isNaN(n))return e+t+n` —— 范围里只要有个
文本格（如 `x`），结果就拼成 `"10+NaN"` 画进那格，看起来像坏公式。
Excel/WPS 的 SUM 是【跳过】非数值格，本仓旧引擎也是 filter 有限数值再求和。
改成累加器遇到 NaN / 非有限值就跳过：范围 `[3,7,"x"]` ⇒ `10`：

```
{key:"SUM",title:U("formula.sum"),render:function(t){return t.reduce(function(a,e){var n=Number(e);return Number.isNaN(n)||!Number.isFinite(n)?a:a+n},0)}}
```

e2e 坐标探针实测过这一格：修之前画 `10+NaN`、修之后画 `10`。

## 改动四（承重）：早触发的工具栏 resize 不再炸画布

库把 `window "resize"` 直接接到工具栏排版函数 Ca 上，而 Ca 一进门就读
`this.btns2`。但 `btns2` 只在工具栏 `reset()` 里的一个 `setTimeout(0)` 里
才建（`this.btns2=[]`），构造时不设 —— 所以任何落在「工具栏初始化完成之前」的
resize 都会让 `btns2` 是 `undefined`，`o.forEach` 直接抛 TypeError，**整张画布挂掉**。
宿主编辑器（`group.js` 的 `renderSheetEditor`）在尺寸从 0 恢复时会主动补发一次
`window "resize"` 走库的重排路径 —— 正好可能撞上这个窗口（e2e 实测间歇性触发）。
改成 `o=this.btns2||[]`：没建好就按空按钮表排版（那时本也没内容可排），
下一次正常 resize 再补齐：

```
i=this.moreEl,o=this.btns2||[],a=i.dd
```

## 升级 / 重新 vendor 之后要做什么

重跑 `.workbuddy/scratch/xds-vendor-patch.py`（幂等：已打的跳过、没打的锚点命中数不等于 1 会自己停）。
行为由 `test/e2e/sheet-editor.spec.ts` 里那几发钉住：错函数名不许把网格画空、
COUNT/ROUND 要真算出数、SUM 遇文本格要跳过得 10、早 resize 不许把画布画崩。
