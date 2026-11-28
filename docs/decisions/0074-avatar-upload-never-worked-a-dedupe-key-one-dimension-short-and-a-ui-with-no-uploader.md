# 0074 · 头像上传这条功能链从来没通过 —— 去重键比它声称的性质少一整维，而屏幕上根本没有上传按钮

**日期。** 2026-11-27（round388-389）。
**落地。** `packages/hub/src/assets/service.ts`（查重键补 purpose 那一维）；
新迁移 `packages/hub/resources/migrations/0029_assets_dedupe_per_purpose.sql`（索引换成
`(sha256, purpose)`）+ `0012_assets.sql` 就地标注；`packages/web/public/group.js`
（招聘表单与成员设置页接上真上传按钮 + 资产/种子二选一守卫）；
新链路测试 `packages/hub/test/assets/avatar-chain.test.ts`（4 发，HTTP 全链路）；
`service.test.ts` +2、`schema-upper.test.ts` 重命名 1 改 1、`migrate.test.ts` 版本清单 +1；
`test/e2e/group-workbench.spec.ts` +2（设置页全链路含守卫、招聘表单用工照）。

## 1. 一句话

「给成员传一张图当头像」这件事，从界面到库层有**三道各自独立**的断点，任何一道都足以让功能死透：

1. **屏幕上没有上传入口。** 招聘表单和成员设置页的头像字段是一个要人手打的
   `avatar_asset_id` 文本框（占位符写着「先通过 assets 上传」），而整个界面**没有任何一处**
   调用 `POST /api/v1/assets` 当 `purpose=avatar` —— 提示让人去上传，上传的门在界面上不存在。
   接口是通的（`POST /api/v1/assets` 一直有、校验也齐），缺的是【生产者】。
2. **就算拿到 asset_id，上传器查重键少一维。** `putAsset` 的查重 SQL 原来只按
   `sha256` 找旧行，而库里那道索引（0012）也真是全表唯一 —— 于是**同一份字节只要曾以
   `attachment` 用途传过，再以 `avatar` 传就拿回附件那一行**；随后头像门
   （`SELECT 1 … WHERE asset_id = ? AND purpose = 'avatar'`，两处：
   `packages/hub/src/members/service.ts:265` 与 `packages/hub/src/http/people.ts:440`）
   按用途拒 ⇒ 绑定必拒 `asset_not_found`。**方向 B 更阴**：先当头像传、再当附件传同一份字节，
   拿回的是头像行与头像的 mime —— 不报错，静默串数据。
3. **两个字段可以同时提交。** `updateAvatar` 把 `avatar_asset_id` 与 `avatar_seed`
   一起读上来、资产赢种子输，表单却把两个字段并排放 —— 用户填了两个，屏幕上没有任何话告诉他
   只能二选一。

## 2. ⭐ 病根的形状：文件头写的是【性质】，索引建的是【性质少一维】

0012 文件头原话是「按内容去重，同一字节只存一份」—— 这是**性质**；它配套的
`CREATE UNIQUE INDEX idx_assets_sha ON assets(sha256)` 把这条性质实现成了**全表唯一**。
但 `purpose` 那一列从建表起就带着 `CHECK (purpose IN ('avatar','attachment','import-source'))`，
而且**头像必须 `purpose='avatar'` 是写进 members/service.ts 文件头的渲染事故理由**
（附件字节画进 32px 圆圈 = 事故）。也就是说这张表**同时**被要求：

- 按内容去重（省 BLOB）；
- 按用途隔离（渲染事故门）。

「同一字节只存一份」与「不同用途不能共用同一行」在只有一维的键上**互斥**。谁都没错，
是交集没人负责。所以修法不是把两道门哪一道拆掉，而是把键补成二维：
**去重归去重（同用途同字节仍只存一行），隔离归隔离（换用途必是新行）** —— 这正是
0061 处理「迁移文件与它声称的性质不符」的先例形状：性质是对的，把索引改成配得上它的形状。

0029 不搬一行数据：现有行 sha256 全表唯一 ⇒ 加一维之后仍唯一，DROP/CREATE 是纯索引操作；
0012 就地加 ⚠ 标注（0061 对 0004 的待遇），新读者在案发现场就能看到键换过形状。

## 3. 界面侧补生产者

`avatarImagePicker()`（`packages/web/public/group.js:6398`）：隐藏 `<input type=file>` +
按钮「上传图片作为头像」，选中即 `uploadAssetBase64(file, "avatar")` 走真
`POST /api/v1/assets`，把返回的 `asset_id` 写进**同一张表单**的隐藏 `avatar_asset_id`
并清空种子，toast「点头像已上传…点保存按钮生效」的口径（toast 文案是
「头像图片已上传，点保存按钮生效。」）。挂在两处：招聘表单（原来那个手打 asset_id 文本框
整个换掉）与成员设置页头像区（隐藏槽 + 按钮）。`updateAvatar` 加守卫：两个字段同时非空
⇒ toast 二选一、**不发请求**（变异 M11 摘掉守卫后 e2e 里 `avatarWrites === 0` 那条断言即红）。

## 4. 判据怎么分的

- **库层**（`schema-upper.test.ts`）：同用途同字节第二条必炸（原有那发重命名成
  「按 (sha, purpose) 去重」）+ 新发「换用途不共键：同字节不同 purpose 各存一行」。
- **服务层**（`service.test.ts` +2）：附件字节换头像用途 ⇒ 新行且**逐字复用头像门那句 SQL**
  判它必须过门；反向各保各的 mime。
- **HTTP 全链路**（新 `avatar-chain.test.ts`，4 发）：真签名、真路由、真迁移库 —— 附件 201 →
  同字节头像 `created:true` 且拿到自己的行 → 拿附件 id 绑头像 422 `asset_not_found` 且库里
  头像列原样 → 拿头像 id 绑定 200 且 `MemberUpdated` 事件落库（`expectPersistedEvent` 形状）。
  选新文件而不是往 1556 行的 `domain-routes.test.ts` 里追加：那边有一对重复的 0028 块，
  追加改动容易踩；新文件自己 `mkdtemp` 库、自己起 WriteQueue，隔离自带。
- **DOM 接线**（e2e +2）：app-loader 的既有立场是「碰 DOM 的渲染入口不在 node 射程内」
  （0039），所以界面那两根线只能 Playwright 证。设置页一发走完：点按钮 → filechooser →
  断言 POST body 是 `{purpose:"avatar",mime:"image/png"}` → 隐藏槽接住 id、种子清空 →
  保存 → `POST /members/pm-ui/avatar` 带 asset_id → 刷新后服务端行仍在、重建的表单里
  `<img>` 指向 `/api/v1/assets/<id>` → 守卫腿（再传同字节 `created:false` 复用 + 填种子保存
  ⇒ toast 二选一且**一次写请求都没发**）。招聘一发：选图上传 → 入职请求带的是
  `avatar_asset_id` 而不是种子。

## 5. ⭐ 同字节两用例互相喂数据：一次自己咬自己的顺序耦合

两只 e2e 用例最初共用同一枚 1×1 PNG 常量。单跑各自绿；`-g "头像上传|招聘用工照"` 合跑时
设置页那发红在 `created` —— 招聘用例（文件在前）先把同一份字节存成了 avatar 行，
设置页再传就成了合法的 `created:false`。**判据没错，是用例把「第一次传」当成了自己的私有前提。**
修法是给每只用例自己的字节（第二枚 PNG 现场生成、base64 规范化自证），而不是把断言改成
`created` 两可 —— 后者会把「内容寻址复用」这半边判据洗掉。同一次合跑也顺手证明了
跨用途不互吃：M5（不 DROP 旧索引）变异下红的正是「先附件后头像」与方向 B 那两发。

## 6. 变异机 13/13

`.workbuddy/round389-mutation.mts`（vitest 与 playwright 双 runner，摘要行读不到即中止）：
M1 去重键退回只按 sha / M2 查重侧写死 attachment / M3 复读侧写死 attachment /
M4 索引去掉 UNIQUE / M5 不 DROP 旧索引 / M6 版本清单里的 0029 写成对不上名 /
M7 头像门放行附件字节 / M8 上传器 purpose 改 attachment / M9 设置页不挂按钮 /
M10 招聘表单不挂按钮 / M11 摘二选一守卫 / M12 保存永远走种子 ⇒ 12 发该红全红，
各发红的是**自己该抓的那几发**（逐发点名读数在 log）；C1 控制组（无关注释）该绿。
预检（未变异）7 个目标面全绿才开跑。⭐ **锚点唯一性预检在第一圈就抓出一发假变异的前置**：
控制组锚点 `const seed = data.get("avatar_seed").trim();` 在 group.js 出现 **2 次**
（`updateAvatar` 与另一条同形函数）⇒ 跑之前直接抛，换成出现 1 次的函数声明行。
每发各自 `finally` 还原 + 单发 sha256，收尾全文件逐字节核对。

## 7. 记下来但没动的

- `GET /api/v1/assets/:id` 把上传方自报的 `mime` 原样回填，且 `packages/hub/src` 没有任何
  `X-Content-Type-Options: nosniff`/CSP。上传面目前只被自己的界面用（purpose/mime 都过 schema），
  但「传一张真 PNG、mime 谎报 `text/html`」的字节将来会被浏览器按 HTML 闻 —— 要修就是
  响应头一行的事，立不立案等一句话。
- 头像门的两份拷贝（`members/service.ts` 与 `http/people.ts`）语义一致、各有承重测试，
  0074 不合并（合并是另一篇的活）。
- e2e 的登录/装配复用既有夹具，本篇没有把 `workers` 从 1 改动 —— 顺序独立性靠每用例
  自己的字节，不靠调度运气。

## 8. 实跑读数

- 定点：`packages/hub/test/assets` 8 passed（chain 4 + service 4）· `test/db` 186 passed ·
  `members/service.test.ts` 30 passed · `domain-routes` + `members` 目录合跑 234 passed（11 文件）。
- e2e：`头像上传：选图即传…` 与 `招聘用工照…` 单跑与合跑全绿（合跑 2 passed）。
- 变异机 **13/13**（12 该红 + 1 控制组绿），逐发还原核对 sha256。
- `tsc -b` 与 `tsc -p tsconfig.test.json --noEmit` exit 0；改动文件 biome 0 诊断
  （`2>&1` 读数，逐条比规则名，净新增 0）。
- `group.js` `node --check` 通过。
- **全量**：`vitest run` **201 文件 / 4216 passed / 6 skipped**（新 avatar-chain 在面内）·
  Playwright 全量 **59 passed**（57 → 59，新增两支头像用例）。
- **守卫重钉**：`test/arch` 全量 **38 文件 / 613**（doc-refs 新增三条 0074 活坐标后
  2/2 绿、decision-index 认账 0074、doc-coords/claim-coords/claims-registry 绿、
  test-inventory 无 uncollected/phantom）。⚠ `lint-baseline` 第一圈红在 `format=1` =
  我自己在 doc-refs.test.ts 里手写的那三行 SNAP 超长字面量 —— 与 0073 同族毛病，
  **biome --write 修代码而不是登记基线**；修后 `biome check .` 的 format 命中归 0。
- `verify-open-invariants.mjs` SUCCESS（提交引用全部可解析）· `check-gate.mjs`
  判不了或不符的项 **0**（C7 轮次相对指称 0 处）· U+FFFD 两文件各 **0**。
