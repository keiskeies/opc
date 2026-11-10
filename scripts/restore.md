# 从备份恢复（出事了才读这份）

先说结论：**恢复是一个会覆盖现网库的动作，而 `events` 是 append-only —— 覆盖掉的那部分找不回来。**
所以工具默认拒绝覆盖，要你显式确认。这不是繁琐，是这条路径上唯一一次反悔机会。

## 什么时候需要这份文档

- `hub` 启动时完整性检查报 violated（规格 §24 风险 8 那条「失败则提示从备份恢复」）。
- 库文件打不开、报 "database disk image is malformed"。
- 误删 / 同步盘把 `~/.opc-os/hub.db` 改了或截断了。

## 第 0 步：先别再写这个库

恢复流程之外的一切写操作都要停掉。Hub 进程要先停 —— 它还开着连接的话，
你复制进去的文件和它内存里的页会打架，而且它随时可能把旧页写回磁盘。

## 第 1 步：看清有哪些备份

```bash
ls -1t ~/.opc-os/backups/
```

文件名形状是 `opc-2026-11-12T03-04-05-123Z.db`：**字典序就是时间序**，
所以 `ls` 默认的字典序排列即「旧 → 新」，最后一个就是最新那份。
（不靠 mtime：mtime 会被 cp / rsync / git checkout 改掉，一次复制就能把最旧的排到最后。）

只认这个形状的文件。目录里可能有你手工拷进去的东西，`restoreBackup` 也会拒绝
非这个形状的文件 —— 那是刻意的摩擦，不是校验过严。

## 第 2 步：先验一眼这份备份自己是好的

```bash
sqlite3 ~/.opc-os/backups/opc-<那个时间戳>.db 'PRAGMA integrity_check'
```

期望输出恰好一行 `ok`。如果不是，**不要**用它恢复（工具也会拒绝），换更早的一份。

## 第 3 步：把现网库留一份，再恢复

工具默认不覆盖已存在的目标。所以先自己改名留一份，而不是传那个「确认覆盖」的开关：

```bash
mv ~/.opc-os/hub.db ~/.opc-os/hub.db.damaged-$(date +%Y%m%d-%H%M%S)
```

然后恢复：

```js
import { restoreBackup } from "./packages/hub/src/db/backup.js";

const r = restoreBackup({
  backupPath: "/Users/<你>/.opc-os/backups/opc-<时间戳>.db",
  targetPath: "/Users/<你>/.opc-os/hub.db",
});
console.log(r);
```

`r.ok === true` 时它已经做完三件事：验过备份自身、**清掉目标旁边残留的 `-wal` / `-shm`**、
复制完再复验一次目标（行数必须与备份一致）。

**那个清理不是可选步骤**，这是本条路径上最容易踩空的地方：
实测把 A.db 复制成 B.db、再把 A 的 `-wal` 复制成 `B-wal`，打开 B 会得到
`journal_mode` 变回 wal、行数 500→520，而 `PRAGMA integrity_check` **仍然报 "ok"**。
也就是说「上次恢复留了个 -wal 在目录里」这种普通事故，会得到一份
**通过了完整性检查、内容却不是那个备份**的库，而且没有任何一层会报。
所以工具把 sidecar 清理放在复制【之前】，并把清掉了什么回报在 `removedSidecars` 里。

## 第 4 步：确认恢复出来的库能用

```bash
sqlite3 ~/.opc-os/hub.db 'PRAGMA integrity_check; SELECT count(*) FROM events;'
```

行数应当与 `restoreBackup` 返回的 `events` 一致。然后再启 Hub。

## 失败信息怎么读

| reason | 意思 | 下一步 |
| --- | --- | --- |
| `backup_missing` | 备份文件不存在 | 路径写错了，或者那份已经被保留策略删掉（只留最近 7 份） |
| `backup_unverified` | 文件名不是备份形状 / 备份自身或恢复后的目标未通过 `integrity_check` / **恢复后行数与备份不一致** | 换一份更早的备份。行数不一致那一支说的是「两侧都通过了完整性检查而落地内容与备份不是同一份东西」—— 先查同目录的 `-wal` |
| `target_exists` | 目标库已存在而没给 `confirmOverwrite` | 按第 3 步改名留一份，别直接确认覆盖 |

## 最后：确认覆盖那个开关

`confirmOverwrite: true` 只有一种正当用法：你已经确认**目标库里没有比备份更新的事件**。
如果拿不准，就走第 3 步改名。改名失败最多是多占一份磁盘，
覆盖失败是**永久失去一段审计历史**，而恢复动作本身写不进那个正要被覆盖的库
（它是文件系统操作，写不进自己正在覆盖的目标）—— 所以它连一条审计都留不下。
