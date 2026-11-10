-- IM 身份绑定的 DDL 级判据 + 两列来源信息（0030）
--
-- ⚠ 本文件的标题**刻意不写条数**。判据是一条一条往上加的（第 5、6、7 条全是
-- 写完前四条之后拿**探针**撞出来的，见各节标注），一个手抄在标题里的数字
-- 下一次加判据时必然忘了改 —— 而它坏了不报错，只是让下一个人以为自己看漏了。
-- 「这张表上有几条判据」这件事由 sqlite_master 数得出来，
-- test/bindings/im.test.ts 里那条【按名字点名每一条】的守卫就是它的落点
-- （删掉一条 ⇒ 那一发红；加一条 ⇒ 不需要改这里）。
--
-- ── 这一支补的是哪一格 ──────────────────────────────────────────────
-- `im_bindings` 从 0001 建好到现在**读写方 0 处**（0028 §2 实测：全仓没有一条 SQL
-- 碰过它，我先前那句「这张表今天不存在」是错的，更正也在同一节）。
-- 0028 §2 的结论是「缺的是生产者与那次校验，不是判据，更不是那张表」。
-- 生产者与读侧在 src/bindings/im.ts，而那两边能站住的前提是**这张表上这些性质由
-- 数据库保证**，也就是本文件。
--
-- ── 为什么判据必须落在 DDL 而不是落在 TypeScript 里 ──────────────────
-- 好几条判据各自都有人「从旁边」绕过（下面各节逐条标了是哪一种）：
--   · 平台白名单：TS 里校验 ⇒ 手搓一句 `INSERT INTO im_bindings VALUES('wechat',…)`
--     就绕过了（0002 排除的正是这个取值，而它当时**只由一行注释拦着**）；
--   · 「出生即已验证」：TS 里校验 ⇒ 手工 INSERT 一行 `verified=1` 就凭空造出
--     一个能批审批的身份（那一列的默认值是 `DEFAULT 'ceo'` —— 见 0028 §2 那段）；
--   · 唯一性：「先查再插」留着「都查到没有 ⇒ 都插进去」的窗口。
-- 同一条立场在 0024（卡片去重）与 0025（Hub 唯一写入者）已经走过：**注释与校验拦不住的
-- 东西，不要只用注释与校验拦**（【规格】§8.2 第 4 条）。
--
-- ── 为什么这是第 0005 号迁移，而不是改 0001 ──────────────────────────
-- 0001 由 scripts/extract-appendix-c.mjs 从规格附录 C 机械提取，改它会让「这份 DDL
-- 逐字取自规格」变成假话；而 `im_bindings` 在老库里已经存在，改 0001 对已部署的库
-- 零作用。扩展只能往后加（0002 / 0003 / 0004 文件头同一条理由）。
--
-- 只用 CREATE INDEX / CREATE TRIGGER / ALTER TABLE ADD COLUMN，不 DROP / RENAME / ALTER：
-- 与 0002 / 0003 / 0004 同一条立场。不含 PRAGMA（连接级设置归 src/db/pragmas.ts）。
--
-- ⚠ 触发器体里的 BEGIN…END 让本文件**不能**按分号逐句切 —— migrate.ts 的 applyOne
-- 整文件一次 exec，那是实测过的正确做法（migrate.ts 里那段注释，附录 C 自带 5 个触发器）。

-- ══ 1. 一个平台账号只能有一条绑定 ═══════════════════════════════════
--
-- 这条不是「顺手加的整洁」，它是【规格】把这张表定义成「绑的是【人】不是会话」
-- （0006 §4.1 事实 2：`im_bindings` 把 platform + external_user_id 绑到 ceo_role，
-- 绑的是人）之后**唯一能兑现那句话的形状**。没有它，同一个飞书账号可以有两行，
-- 一行 ceo_role='dev' 一行 ceo_role='ceo'，于是读侧必须**挑一行** ——
-- 而「挑哪一行」这件事没有任何依据（表里没有优先级、没有版本、没有生效区间）。
--
-- 后果说具体：读侧只能靠 LIMIT 1（不带 ORDER BY ⇒ 取决于查询计划，同一份数据
-- 换个 SQLite 版本能给出另一个答案）或者靠「取最新的」（⇒ 谁最后被插进去谁当 CEO，
-- 而插入时间只说明有人插了一行，不说明任何人认可过这件事）。两种都在
-- **静默**决定「这个账号是谁」。
--
-- 所以判据的形状是：**歧义不允许存在**，而不是「存在了以后怎么挑」。
--
-- 为什么索引里不带 ceo_role：一个真人可以有两个平台的账号（飞书 + 企微）都指向
-- 同一个角色，那是【规格】§11.5 三个通道并存时最常见的情形。反过来
-- 「一个角色在同一平台上被两个账号绑」是**要拦的那一种**（共享账号 ⇒ 审计里
-- 「CEO 批了」再也指不出是哪个人），而它正好被这个索引拦掉。
CREATE UNIQUE INDEX im_bindings_identity
  ON im_bindings(platform, external_user_id);

-- ══ 2. 平台取值白名单（0002 那条排除从此不再只由注释拦着）═══════════════
--
-- 0002 §4 量的就是这一格：`platform` 是一列**看起来开放**的 TEXT，
-- 「schema 不拦一个 platform='wechat' 的 INSERT，拦它的是这条决定 + 这条注释」。
-- 0002 §6 第 2 条更把「改成枚举或加校验」列为需要重读那篇的时机之一，并要求
-- 「那一刻要把 §4 那条注释一起改成**机器可判**的」。**本文件就是那一刻。**
--
-- 为什么不用 CHECK 列约束：SQLite 不能对已有列 ADD CONSTRAINT（ALTER TABLE 只支持
-- ADD COLUMN），要 CHECK 就得重建表 —— 而重建表在一张已经有历史行的表上
-- 是「把历史挪一次家」，本仓不挪（同 0002/0003/0004 文件头那条立场）。
-- 触发器能表达同一件事且不改表结构，而且 0001 自己就用了 5 个触发器拦 UPDATE/DELETE。
--
-- ⚠ 白名单里【没有】`wechat`，也【没有】`fake`，两件是不同的事：
--   · `wechat` 是【规格】§11.5 与本仓 0002 排除的通道（理由在那篇，比封号更硬的那条是
--     「逆向接入给不出签名，接不进【规格】§11.4 那条『IM 审批必须签名验证』」⇒
--     一个不能证明「这条批准来自 CEO」的通道不能承载审批）；
--   · `fake` 是**测试用的通道**（src/channels/abstraction.ts 的 `ChannelPlatform`
--     第四位）。它不该出现在这张表里的理由不是「假平台不存在」，是
--     **「绑定表是一张真表，测试夹具不该能通过它拿到真角色」** ——
--     一个 fake channel 配上 `verified=1` 的绑定就能走完整条读侧，
--     那正是 0028 §2 说的那条冒充通道，只是换了入口。
--     ⇒ `ChannelPlatform`（4 个值）**严格大于**这张表白名单（3 个值）是刻意的，
--       有一条测试专门钉住这个不相等，防止有人「为了一致」把 fake 加进来。
--
-- 大小写：SQLite 的 TEXT `=` 默认 BINARY 排序（区分大小写），所以 'Feishu' 走不到白名单
-- 里任何一项 ⇒ 当场被拦。这是**特性**：那列里从此只有三种精确写法，
-- 于是「绑上了而永远查不出来」（写侧存 'Feishu'、读侧查 'feishu' ⇒ 恒 null，
-- 而界面上显示「已绑定」）这一整类静默失效被关在门口。
-- 归一化（trim / 转小写）由 src/bindings/im.ts 在**校验之前**做，
-- 触发器只做最后一道兜底 —— 顺序反了会变成「用户手滑打个大写 ⇒ 一句数据库报错」。
--
-- ⚠⚠ 条件写的是 `IS NOT NULL AND … NOT IN (…)` 而不是 `NOT IN (…)`，这一格是
-- **实测撞出来的**（第一版写成 `NEW.platform IS NOT IN (…)` —— SQLite 没有
-- `IS NOT IN`，迁移当场 "near \"IN\": syntax error" 并整体回滚）。
-- 改成 `NOT IN` 就够了吗？**不够，而且是静默的不够**：
-- SQLite 里 `NULL NOT IN ('a','b')` 求值为 **NULL**，而 `WHEN NULL` **不成立** ⇒ 放行。
-- 于是 `platform IS NULL` 的一行能插进来（那列是 NOT NULL，所以今天走不到 ——
-- 但那是**另一条**约束在替这条兜底，而它属于 0001，改表的人不一定看得到）。
-- 把 NULL 支路**显式写进条件**，判据就不借「旁边还有一条 NOT NULL」这种
-- 迟早会被人挪走的依赖（同 0021 §1 那个「两边是同一个值」的教训：
-- 判据不能靠它自己之外的东西成立）。
CREATE TRIGGER im_bindings_platform_insert
  BEFORE INSERT ON im_bindings
  WHEN (NEW.platform IS NULL OR NEW.platform NOT IN ('feishu', 'wecom', 'qq'))
BEGIN
  SELECT RAISE(
    ABORT,
    'im_bindings.platform 只接受 feishu / wecom / qq（0002 排除个人微信，fake 是测试通道不得绑定）'
  );
END;

-- UPDATE 那一发也要拦：只拦 INSERT 的话，「先插一行 feishu，再 UPDATE 成 wechat」
-- 就是白名单的一个洞，而那条路径**看起来比直接插 wechat 更无害**（它经过了一次合法的写）。
CREATE TRIGGER im_bindings_platform_update
  BEFORE UPDATE OF platform ON im_bindings
  WHEN (NEW.platform IS NULL OR NEW.platform NOT IN ('feishu', 'wecom', 'qq'))
BEGIN
  SELECT RAISE(
    ABORT,
    'im_bindings.platform 只接受 feishu / wecom / qq（改绑不许绕开平台白名单）'
  );
END;

-- ══ 3. 一行绑定不许「出生即已验证」═══════════════════════════════════
--
-- 这一条是本文件全部重量所在，因为它拦的是 0028 §2 量出来的那个陷阱：
-- `ceo_role TEXT NOT NULL DEFAULT 'ceo'` 配 `verified INTEGER DEFAULT 0`。
-- 0028 §2 原话：「**把 actorFor 直接接到这张表上**这一行代码今天会造出：
-- 任何一个在这个平台上发过消息、且有人替他插过一行绑定的账号，**默认就是 CEO**」，
-- 而「今天全部测试都会绿」（fake 的假定正是「这个人就是 CEO」）。
--
-- 光靠读侧判 `verified = 1` 够不够？**不够，而且不够的理由值得写下来。**
-- 读侧判 verified 挡的是「读的时候没验过的不算数」；它挡不住「有人**写**了一行
-- verified=1」—— 而那一句 INSERT 才是把冒充变成事实的那一步。
-- 两条判据各挡一半，缺一半就剩下那一半的洞，这正是本仓反复用的形状。
--
-- 有了这条触发器，「一个 IM 账号能批审批」在库里必须是**两次分开的写**：
-- 第一次 INSERT（只能落 verified=0，即「有人在申请」），第二次 UPDATE（那次人工校验）。
-- 而第二次被下一条触发器要求交出**是谁验的、什么时候验的**。
-- 「申请」与「认可」之间隔一次显式的人工写 —— 这就是那次校验从**约定**变成**性质**的地方。
--
-- ⚠ 判据写的是 `IS NOT 0` 而不是 `<> 0`：后者在 verified IS NULL 时求值为 NULL，
-- WHEN 不成立 ⇒ **放行**。而 `verified INTEGER` 是可空列（0001 没写 NOT NULL），
-- `INSERT … VALUES (…, NULL, …)` 完全走得通，那一行既不是「没验过」的 0 也不是 1，
-- 是一个**第三种状态**（读侧 `verified = 1` 判它 false ⇒ 拒，方向是安全的，
-- 但「没验过」与「不知道验没验过」在那张表里长成一件事，下一个人就分不清了）。
-- `IS NOT 0` 把 NULL 一并拦掉，宁可让写侧报错也不留第三种状态。
CREATE TRIGGER im_bindings_no_born_verified
  BEFORE INSERT ON im_bindings
  WHEN NEW.verified IS NOT 0
BEGIN
  SELECT RAISE(
    ABORT,
    'im_bindings 的新行只能是 verified=0（申请）；校验必须是第二次显式 UPDATE（0030 §3）'
  );
END;

-- ══ 4. 改成已验证时，必须同时交出是谁验的、什么时候验的 ═════════════════
--
-- 有了第 3 条，人工校验成为唯一能把 verified 置 1 的路径 ⇒ 那一次写必须留下来源，
-- 否则库里只留下「有一行是已验证的」而**没有任何东西说明谁认为这算验证过**。
-- 那一天真正要问的那一句是「谁断定这个飞书账号就是 CEO」，
-- 而这个问题在库里没有答案的时候，整套「IM 只能批可逆审批」的口子就失去了唯一那层
-- 人为责任 —— 【规格】§11.4 要求「签名验证 + 一次性 token」，签名验的是**消息**，
-- 「这个账号属于谁」这件事从第一天起就没人负责，本文件把它落到一次有署名的写上。
--
-- 为什么这两列加在 im_bindings 上，而不是写进 events：
-- 【规格】§22.1 那个十值 action 枚举里**没有一个**表达「身份绑定」（逐项核过：
-- state_change / review_decision / approval / tool_call / budget_consume / meeting /
-- harness_call / unauthorized_attempt / dissent / escalation）。
-- 沿用既有值（`approval`？`unauthorized_attempt`？）会造出一行**语义错位**的审计：
-- 0021 §2 抓的就是这个形状（「记录是真的、它表达的含义是假的」⇒ 审计越全，失真越可信），
-- 而 §22.1 那个枚举与本表一样是 append-only 的口径（不开第 11 个值，
-- 同 recorder.ts 给 ApprovalTokenRedeemed 选 'approval' 时记的那条理由）。
-- ⇒ 本次把来源落在**绑定行自己身上**（有列可放），把「要不要给身份绑定开一种审计事件」
-- 留给 CEO 拍（0030 §9 登记）。
--
-- 两列都**可空**，且是刻意的：第 4 条触发器只约束「NEW.verified 非 0 时不得为 NULL」，
-- 所以对 0005 之前存在的老行（生产库里 0 行，因为这张表从来没有写方）零作用，
-- 也不必**编**一个 verified_at / verified_by 回填进去 —— 0004 给 created_at
-- 记过同一条：编一个时间戳会让「什么时候验的」这一格永远说谎。
ALTER TABLE im_bindings ADD COLUMN verified_at INTEGER;
ALTER TABLE im_bindings ADD COLUMN verified_by TEXT;

CREATE TRIGGER im_bindings_verify_provenance
  BEFORE UPDATE OF verified ON im_bindings
  WHEN NEW.verified IS NOT 0
   AND (NEW.verified_at IS NULL OR NEW.verified_by IS NULL)
BEGIN
  SELECT RAISE(
    ABORT,
    '把 verified 置 1 必须同时写 verified_at 与 verified_by（那次校验要有署名与时刻，0030 §4）'
  );
END;

-- ══ 5. 已验证的绑定不许【就地换身份】════════════════════════════════
--
-- ⚠ 这一条不是设计出来的，是**探针撞出来的**（脚本 /tmp 那份，跑完即弃）。
-- 前四条写完我以为判据闭合了，于是写了一发探针专门去试我没想到的形状：
--   ① INSERT (feishu, u1, dev, verified=0)            放行（申请）
--   ② UPDATE verified=1 + 署名 + 时刻                  放行（人工校验：这是 dev）
--   ③ UPDATE ceo_role='ceo'                            ← **放行**
-- 第 ③ 步之后库里是一行 `verified=1` 的 **feishu:u1 → ceo**，
-- 而 `verified_by='ceo'` 那句署名说的是【另一次校验】—— 它从来没有校验过
-- 「这个账号是 CEO」这件事。第 3、4 条一起把 INSERT 那条门锁死了，
-- 于是冒充改走 UPDATE 那一侧，而 `verified` 一字未动、时刻没变、署名还在，
-- **审计上一切看起来都是干净的**。这正是 0028 §2 那个陷阱换了个入口：
-- 「默认就是 CEO」变成「改一下就是 CEO，而且带着别人给 dev 做的那次校验」。
--
-- 为什么第 4 条拦不住它：那条触发器是 `BEFORE UPDATE OF verified` ——
-- SQLite 的 `OF` 只在**被点名的列出现在 SET 里**时触发。③ 里 SET 的是 ceo_role，
-- 那条触发器**根本没被唤起**（不是求值为假，是压根没跑）。
-- 这一格是本文件最该被读走的一条经验：**`UPDATE OF col` 的形状意味着
-- 「没被点名的列」上的判据由谁负责必须逐个想清楚**，
-- 而「我把 verified 管住了」这句话当时的真实范围只有「改 verified 时」。
--
-- 修法选的是「**改身份必须先把 verified 落回 0**」，而不是「改身份时必须同时交出新署名」：
--  ① 它让 `verified=1` 获得一条**性质**而不是约定 ——
--    **已验证这一格永远指的是它旁边那一组 (platform, external_user_id, ceo_role)**，
--    读侧不必知道这行被改过几次；
--  ② 「改绑 + 立刻重新校验」压成一条语句也能做到「有署名」（就是第二种修法），
--    而那条语句**长得和合法操作一模一样**，于是判据退化成「看有没有写那两列」，
--    而署名可以是从旁边一行抄来的。两条语句之间那次 verified=0 的中间状态
--    是**库里可查询的**「正在重新申请」（listBindings 读得到；本模块今天没有界面，
--    所以这里说的是「数据模型不必为了接界面而改」而不是「已经看得见」——
--    这个区别与更正过程见 0030 §3 末尾），
--    一步到位的版本连这一格都没有。
--  代价：改绑在最顺的路径上也是两次写。这个代价我认 ——
--  省下的那一次写在**冒充**那一侧同样只省一次。
--
-- `IS NOT` 而不是 `<>`：三列都可空吗？platform / external_user_id / ceo_role 在 0001 里
-- 全是 NOT NULL，所以 `<>` 今天等价。但这条触发器的**整个存在理由**是「判据不能靠
-- 旁边那条约束成立」（§2 末段同一条），而 `NULL <> 'x'` 求值为 NULL ⇒ WHEN 不成立 ⇒ 放行。
-- 用 NULL 安全的 `IS NOT`，这发触发器就自己闭合，不需要 0001 替它担保。
CREATE TRIGGER im_bindings_rebind_resets_verified
  BEFORE UPDATE OF platform, external_user_id, ceo_role ON im_bindings
  WHEN NEW.verified IS NOT 0
   AND (
        NEW.platform IS NOT OLD.platform
     OR NEW.external_user_id IS NOT OLD.external_user_id
     OR NEW.ceo_role IS NOT OLD.ceo_role
   )
BEGIN
  SELECT RAISE(
    ABORT,
    '已验证的绑定不许就地换身份：改 platform / external_user_id / ceo_role 必须同一条语句把 verified 落回 0（0030 §5）'
  );
END;

-- ══ 6. verified 只能是 0 或 1（不许第三种状态）═══════════════════════
--
-- 第 3 条把 INSERT 钉死在 0，但**没钉上界**：`UPDATE … SET verified=2`（带着署名）
-- 是**放行**的（实测），于是库里多出一个既不是「已校验」也不是「未校验」的第三态。
-- 读侧只认 `= 1`，所以那一行**当前**不会被当成已校验 —— 方向是安全的，
-- 但这一格与本文件 §3 末尾反对 `verified IS NULL` 用的是**同一条理由**：
-- 「没验过」与「不知道验没验过」在那张表里长成一件事，而下一个人只能猜。
-- 更现实的一条：读侧今天是 `verified = 1`，哪天有人「顺手放宽」成 `verified != 0`
-- （读起来几乎等价，而且看起来像在修一个「2 也算已校验吧」的疑问），
-- 那一行**立刻**变成一个能批审批的身份。把取值钉成两个，
-- 那次放宽就没有东西可以命中。
--
-- INSERT 那一侧不再单开触发器：第 3 条 `WHEN NEW.verified IS NOT 0` 已经把 2 拦了。
--
-- ⚠ 为什么 `IS NOT 1` 不会被字符串 `'1'` 误伤（实测）：那列的声明类型是 INTEGER，
-- SQLite 的列**亲和性（affinity）在触发器之前**就把 `'1'` 转成了整数 1
-- （`SELECT typeof(verified)` ⇒ `integer`）。所以这一条不会拦住一个合法写入。
CREATE TRIGGER im_bindings_verified_boolean
  BEFORE UPDATE OF verified ON im_bindings
  WHEN NEW.verified IS NOT 0 AND NEW.verified IS NOT 1
BEGIN
  SELECT RAISE(
    ABORT,
    'im_bindings.verified 只能是 0 或 1（第三态会在任何人把读侧放宽成 != 0 的那一刻变成通行证，0030 §6）'
  );
END;

-- ══ 7. 未验证的行不许留着校验署名 ═══════════════════════════════════
--
-- 这一条同样是**探针撞出来的**，而且它撞的形状我事先完全没想到：
-- 用一条 UPSERT 把已校验的绑定换身份并顺手把 verified 落回 0（第 5 条允许的做法），
-- 结果是库里躺着一行
--     verified = 0   ceo_role = 'ceo'   verified_by = 'ceo'
-- 也就是**一句「ceo 校验过」的署名挂在一个「没校验过」的行上**。
-- 第 5 条要求「改身份必须把 verified 落回 0」，而它**没有要求同时清掉署名** ——
-- 判据的缺口不在写侧那条 SQL 上（src/bindings/im.ts 的 rebindRole 两个字段都清了），
-- 在「别人从旁边写」的那一侧：UPSERT、手搓 UPDATE、将来的第二个生产者，都不走那条 SQL。
--
-- 后果不是权限洞（读侧只认 verified = 1，那一行拿不到任何批准权），
-- 是**一句已经在库里的假话**：那一行带着 verified_by='ceo' 被 listBindings 原样交出来，
-- 读它的人（今天是我用 SELECT，将来是那个列表界面）会把「校验人：ceo」当成事实，
-- 而这个人此刻**没有**任何校验成立。原本这里写的是「**界面上**的一句假话」，
-- 而那个列表界面今天还不存在（0030 §0）—— 那样写反而**把这一格说小了**：
-- 它不是「等有了界面才出现的显示问题」，是数据今天就在说谎，后来的读者只需去信它一次。
-- 0021 §2 抓的就是这个形状 —— 记录是真的（ceo 确实校验过**某件事**），
-- 它此刻表达的含义（他校验了这个身份）是假的。本仓把这一族列为最贵的一类，
-- 因为它让审计**看起来**更可信而实际上更误导。
--
-- 判据写成一条性质：**「未验证」这一格与「有署名」这一格互斥**。
-- 于是「谁验的」这句话在那张表里永远与「验过了」同时出现，缺一即另一缺一。
--
-- ⚠ 触发器覆盖 **INSERT 与任意列的 UPDATE**（不是 `OF verified`）。
-- 理由与第 5 条那条一模一样而方向相反：`OF` 只在被点名的列出现在 SET 里才触发，
-- 而这里要拦的正是「改了 verified_at / verified_by 而没改 verified」
-- （比如给一行未验证的绑定单独补一个署名）。写成 `OF verified` 就漏掉那一发。
-- 代价是这张表每次 UPDATE 多跑一次条件判断 —— 行数是个位数量级，不成立为代价。
CREATE TRIGGER im_bindings_unverified_has_no_provenance
  BEFORE INSERT ON im_bindings
  WHEN NEW.verified IS 0
   AND (NEW.verified_at IS NOT NULL OR NEW.verified_by IS NOT NULL)
BEGIN
  SELECT RAISE(
    ABORT,
    'verified=0 的行不许带 verified_at / verified_by：那是一句挂在未校验身份上的署名（0030 §7）'
  );
END;

CREATE TRIGGER im_bindings_unverified_has_no_provenance_upd
  BEFORE UPDATE ON im_bindings
  WHEN NEW.verified IS 0
   AND (NEW.verified_at IS NOT NULL OR NEW.verified_by IS NOT NULL)
BEGIN
  SELECT RAISE(
    ABORT,
    'verified=0 的行不许带着 verified_at / verified_by：那是一句挂在未校验身份上的署名（要把 verified 落回 0，就在同一条语句里清掉那两处；0030 §7）'
  );
END;


