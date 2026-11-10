# events_fts 重建口径（`fts_index` 报 violated 时读这份）

## 先确认是哪一种

`fts_index` 报 violated 时的 detail 会点名具体的 `events.id`。三种成因，修法不同：

1. **索引缺行**（最常见）：`events` 里有行，索引里检索不到它。
   成因通常是有人绕过触发器直接改了 `events`，或在 `events_fts` 上直写过 `'delete'`。
2. **索引整块没了**：detail 会说「这份库里没有 events_fts」。
3. **shadow 表坏掉**（`events_fts_data` / `events_fts_idx` / `events_fts_docsize` /
   `events_fts_config` 之一不在）。表现也是缺行，但重建之前先确认这四张在不在。
   实测这份库里 `events_fts` 相关对象共 8 个：`events_fts` + 上面四张 shadow 表 +
   `events_fts_insert` / `events_fts_ad` / `events_fts_au` 三条触发器。
   注意**没有** `events_fts_content` —— 因为 `content='events'`，内容就存在 `events` 里，
   external-content 模式不另开一份内容表。（我写这份文档的第一版把它列成了
   `events_fts_content`，那是一张不存在的表；照着敲会得到 "no such table"，
   而那一刻人正在处理一次数据故障，最容易把报错读成「故障比想象的深」。）

`events_fts` 是 **external content** 表（`content='events'`）：它自己**不存 payload**，
只存指向 `events` 的倒排。所以「索引与表分叉」不会让 `PRAGMA integrity_check` 报任何东西
（实测，见 docs/decisions/0018 第 8 条），也**不会**让 `events` 少一行 —— 坏掉的只有检索：
回放搜索会报「没有相关事件」而真相是命中行不在索引里。

## 重建

三条都在**写连接**上跑（`openDb()` 那条，不是只读连接）。顺序不能换。

```sql
-- 1) 把索引整体清空并重灌。'rebuild' 是 fts5 的维护命令，
--    它按 content='events' 重新读一遍内容表，所以不需要外部脚本。
INSERT INTO events_fts(events_fts) VALUES('rebuild');
```

跑完必须**复验**，不要跑完就算完（下面这条命令是真跑过的，结论在下面）：

实测一份 60 行的库，人为从索引里删掉第 38 行之后：

```
BEFORE fts_index = violated（索引里找不到这些事件行：38）
AFTER  fts_index = ok（抽 60 行，每行用自己 payload 的一段 trigram 回查索引，全部命中）
rows still 60
```

`events` 一行没少 —— 再一次说明这是派生物向真相对齐。

```bash
# 同一条检查再跑一次，fts_index 应当回到 ok
PATH=~/.nvm/versions/node/v24.14.0/bin:$PATH \
  node --experimental-transform-types --import /tmp/opc-harness/register.mjs \
  --test "packages/hub/test/db/integrity.test.ts"
```

或者直接对那个库跑一次检查（`runIntegrityScan` 会连页面检查与自洽一起出）。

## 三条不要做

- **不要 `DROP TABLE events_fts` 再 `CREATE VIRTUAL TABLE`。** 那样会连带丢掉
  `events_fts_insert` / `events_fts_ad` / `events_fts_au` 三个同步触发器引用的目标重建时机，
  而 `resources/migrations/0001_init.sql` 里那三条触发器与虚拟表是在同一个迁移里建的 ——
  手工重建很容易只重建虚拟表、留下指向旧 shadow 的触发器。用 `'rebuild'`。
- **不要为了「让检查变绿」去改 `events`。** 那张表被 `events_no_update` / `events_no_delete`
  两个触发器强制只增不改，而且**它才是真相**：索引是它的派生物，派生物向真相对齐，
  不是反过来。
- **不要在只读连接上跑。** `'rebuild'` 是写操作，只读连接上会抛
  "attempt to write a readonly database"。

## 如果 rebuild 之后仍然 violated

那说明分叉不是「索引缺行」而是**内容表自己在变**（有旁路连接在写 `events`，
绕过了 `WriteQueue` 那台单写者）。这时候要查的是写入路径，不是索引：
规格 §5.5 的单写者前提已经不成立，而 `integrity.ts` 的 append-only 探针
在这一库里也会给出可疑结论（它撞不到触发器时说的是「一行都没匹配到」）。
