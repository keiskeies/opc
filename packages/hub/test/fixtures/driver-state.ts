/**
 * 测试夹具：一台 Hub 的【驱动器状态】（0048 §7 那一格的输入）。
 *
 * ── 为什么要有这个文件而不是每个测试自己写一行 ────────────────────
 * HubDeps.driverState 是【必填】的，而必填的代价会转嫁给每个构造 HubDeps 的测试
 * （本仓有 11 处）。那笔转嫁是【故意付的】—— 见 HubDeps.driverState 旁边那段：
 * 「这台机器有没有在推」这件事必须被每个构造点回答，否则看板会在驱动器关着时
 * 画一张空名单，读起来是"一切正常"。
 * 但"必须回答"不等于"必须重新发明答案"：这里给三个【具名】的机器，
 * 每个测试点自己【选一个名字】，于是它仍然答了一次（选了哪一台是它写的），
 * 而不必抄一段 SQL 形状。
 *
 * ── 为什么【没有】缺省值 ──────────────────────────────────────────
 * 这个文件里任何函数都不叫 `driverState()`，也没有 `defaultDriverState`。
 * 一个缺省会做与"可选参数"完全相同的事：让忘记回答变得无感。
 * 三个名字就是三种答案，选一个是一行代码而【不是一句思考都不用的】一行。
 *
 * ── 三个名字各自对应一台真机 ──────────────────────────────────────
 *  DRIVER_OFF        —— `hub:serve` 不带 --driver-pump（今天默认就是这台，一分钱不花）
 *  DRIVER_ON         —— 带了 --driver-pump 且三个上限齐全，心跳在跑
 *  DRIVER_PUMP_DEAD  —— 开着而承载它的那条心跳连番失败之后停了（0048 §7 那一格
 *                       存在的理由之一：那一刻 HTTP 仍在服务而没人推了）
 * 第四个取值（enabled 而 taskLimitCents 为 null）今天【没有真机器对应】：
 * bounds.ok 为假时驱动不开，所以装配层给的 enabled 必假 ⇒ 那一档不可达。
 * 所以这里不提供它，而 driver-status.ts 里那条「分母不知道时不许下判断」的
 * 用例仍然直接构造那个形状去问读侧 —— 那是【读侧的判据测试】，
 * 不需要一台不存在的机器当分母（0048 §9 的 M7 记的就是"为恒假的分支造注入用例"的代价）。
 */
import type { DriverRuntimeState } from "../../src/overview/driver-status.js";

/** 这台 Hub 没开驱动器（命令行没有 --driver-pump）。 */
export const DRIVER_OFF: DriverRuntimeState = {
  enabled: false,
  pumping: false,
  taskLimitCents: null,
};

/**
 * 开着且在推，每条任务的上限 500 美分。
 *
 * ⚠ 那个数是【夹具挑的】而不是从某个默认值抄的：DEFAULT/真实上限来自命令行，
 * 没有代码缺省（0048 文件头那条「花钱的东西不给默认值」）。
 * 测试里要它是因为「被钱挡住」那一档需要有一个分母才能被构造出来。
 * 要换一个数就自己构造对象 —— 这里不给 setLimit 之类的构造器，
 * 那会把"这一台的上限是多少"重新变成一个可以忘记回答的东西。
 */
export const DRIVER_ON: DriverRuntimeState = {
  enabled: true,
  pumping: true,
  taskLimitCents: 500,
};

/** 开着而心跳已经停了（onFatal 之后：HTTP 仍在服务，没人推了）。 */
export const DRIVER_PUMP_DEAD: DriverRuntimeState = {
  enabled: true,
  pumping: false,
  taskLimitCents: 500,
};
