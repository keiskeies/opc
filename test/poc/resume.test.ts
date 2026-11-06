import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Task 0.1：把 Phase-0 可行性验证固化成仓库内测试。
 *
 * 覆盖设计文档 §23.1 的门禁：
 *   #1 并行分支 + 汇聚节点        → 见『门禁 #1』
 *   #4 interrupt → resume        → 见『门禁 #4』（V2：interrupt 不抛异常）
 *   #5 子图嵌套                   → 见『门禁 #5』
 *   #2 跨进程从 Checkpoint 恢复   → 见『门禁 #2』（本文件真的 spawn 独立进程）
 *   反例守卫                      → 见『反例守卫』（实测：重复 invoke 会整图重跑）
 *
 * 依赖归属：@langchain/* 目前装在仓库根，Task 0.2 建 workspace 后迁到 packages/hub。
 */

const POC = fileURLToPath(new URL('../../packages/hub/src/poc/', import.meta.url));
const TMP = '.tmp/poc';

type Phase1 = { phase: string; threadId: string; interrupts: unknown[]; next: string[]; trail: string[] };
type Phase2 = { phase: string; resumedNext: string[]; resumedTrail: string[]; finalTrail: string[] };
type Wrong = { phase: string; outcome: string; finalTrail: string[] | null; next: string[] };

function node(script: string, args: string[]) {
  const out = execFileSync(process.execPath, [join(POC, script), ...args], {
    encoding: 'utf8',
    timeout: 120_000,
    maxBuffer: 32 * 1024 * 1024,
  });
  const line = out.trim().split(/\r?\n/).filter(Boolean).at(-1) ?? '';
  return JSON.parse(line);
}

const uniq = () => String(Date.now()) + '-' + Math.random().toString(36).slice(2, 8);
const fresh = (tag: string) => {
  mkdirSync(TMP, { recursive: true });
  return join(TMP, 'ckpt-' + tag + '.db');
};

let dbPath: string;
let threadId: string;
let phase1: Phase1;

beforeAll(() => {
  const tag = uniq();
  dbPath = fresh(tag);
  threadId = 'poc-' + tag;
  // 阶段 1：跑到 interrupt 暂停后进程退出 —— 模拟「Hub 在 CEO 审批前被杀掉」
  phase1 = node('poc-run.mjs', [dbPath, threadId]) as Phase1;
});

afterAll(() => rmSync(TMP, { recursive: true, force: true }));

describe('门禁 #1 并行分支与汇聚节点', () => {
  // 注意：这里【故意不断言 trail 顺序】。
  // 变异测试（2026-11-06）证明：把 addEdge(["gateA","gateB"], "merge") 改成
  // addEdge("gateA", "merge")，trail 顺序完全不变 —— 因为 Pregel 超步调度会把同一
  // superstep 的兄弟节点（gateA 立即完成、gateB 慢 300ms）整批收尾后才进下一超步。
  // 所以「顺序」对 fan-in 语义【没有鉴别力】，断言它只会制造虚假安全感。
  // 「汇聚节点确实等齐了多方写入」这件事由门禁 #5 的 judge:2 负责 —— 它读的是
  // 【汇聚节点看到的 state 值】，那才是可观测证据。
  //
  // 对 Phase 1 门控的直接含义：不要以为写了数组边就一定等齐，必须断言汇聚节点
  // 真的读到了每个上游的产物（见 Task 1.2 evaluateGate 的入参校验）。
  it('两个并行门控都执行过（含慢分支 gateB 被等到）', () => {
    expect(phase1.trail).toContain('gateA-pass');
    expect(phase1.trail).toContain('gateB-pass');   // gateB 故意慢 300ms，仍被等到
    expect(phase1.trail.filter(x => x === 'gateB-pass')).toHaveLength(1);
  });

  it('汇聚与产出各只发生一次（不重复计费的前提）', () => {
    expect(phase1.trail.filter(x => x === 'merge')).toHaveLength(1);
    expect(phase1.trail.filter(x => x === 'producer')).toHaveLength(1);
  });

  it('图最终停在审批节点，没有绕过审批直达 END', () => {
    expect(phase1.next).toEqual(['approval']);
    expect(phase1.trail.some(x => x.startsWith('approval:'))).toBe(false);
  });
});

describe('门禁 #4 interrupt 暂停（V2：不抛异常）', () => {
  it('invoke 正常返回，暂停信息在返回值 __interrupt__ 里', () => {
    expect(phase1.interrupts).toHaveLength(1);
    const v = (phase1.interrupts[0] as { value: { question: string } }).value;
    expect(v.question).toBe('CEO 批准？');
  });

  it('待执行节点是 approval', () => expect(phase1.next).toEqual(['approval']));
});

describe('门禁 #5 子图嵌套 + 子图内并行汇聚', () => {
  it('辩论子图三辩手跑完并作为一条 trail 汇入父图', () => {
    const d = phase1.trail.find(x => x.startsWith('debate['));
    expect(d).toBeDefined();
    // pro / con 完成顺序不确定，故只断言格式与各出现一次
    expect(d).toMatch(/^debate\[(pro|con)\+(pro|con)\+judge:2]=go$/);
    expect(d).toContain('pro');
    expect(d).toContain('con');
  });
});

describe('门禁 #2 跨进程从 SQLite Checkpoint 恢复（V3）', () => {
  it('全新进程重启后 next 与 values 完整恢复，且已完成节点不重复执行', () => {
    const p2 = node('poc-resume.mjs', [dbPath, threadId]) as Phase2;

    expect(p2.resumedNext).toEqual(['approval']);
    expect(p2.resumedTrail).toEqual(phase1.trail);
    expect(p2.finalTrail).toEqual([...phase1.trail, 'approval:approved-after-kill']);

    // 已完成节点被重放的唯一证据，就是同一条 trail 里出现第二次
    for (const n of ['producer', 'merge', 'gateA-pass', 'gateB-pass']) {
      expect(p2.finalTrail.filter(x => x === n)).toHaveLength(1);
    }
  });
});

describe('反例守卫：恢复必须走 Command，重复 invoke 是事故（实测 2026-11-06）', () => {
  // 独立数据库，避免被『门禁 #2』跑完后的状态污染。
  // 实测行为（比「什么也没做」危险得多）：重复 invoke 会让【已完成节点整图重跑一遍】，
  // producer / 两个门控 / merge / 子图全部第二次执行 —— 每个真实 LLM 节点都再烧一次钱，
  // 而图【依然】停在 approval，审批并没有被推进。
  it('重复 invoke 会重放已完成节点，且不推进审批', () => {
    const tag = uniq();
    const db = fresh(tag);
    const tid = 'wrong-' + tag;

    const first = node('poc-run.mjs', [db, tid]) as Phase1;
    expect(first.trail.filter(x => x === 'producer')).toHaveLength(1); // 基线：只跑了一次

    const w = node('poc-double-invoke.mjs', [db, tid]) as Wrong;
    const trail = w.finalTrail ?? [];

    // 事故特征 1：已完成节点被重放（真实系统里 = 重复计费）
    expect(trail.filter(x => x === 'producer').length).toBeGreaterThan(1);
    expect(trail.filter(x => x === 'merge').length).toBeGreaterThan(1);
    // 事故特征 2：审批没被推进，图还卡在 approval
    expect(w.next).toEqual(['approval']);
    expect(trail.filter(x => x.startsWith('approval:'))).toHaveLength(0);
  });
});
