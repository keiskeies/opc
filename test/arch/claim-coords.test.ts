import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  bare,
  coordDrifts,
  formatDrifts,
  locateAnchor,
} from "./claim-coords.js";
import { REGISTRY, type RegistryEntry } from "./claims-registry.js";

const ROOT: string = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

function docLines(rel: string): string[] {
  return readFileSync(join(ROOT, rel), "utf8").split(/\r?\n/);
}
const readDoc = (doc: string): readonly string[] => docLines(doc);

/** 合成一条只改坐标的主张，其余字段原样 —— 免得夹具去仿判据正文。 */
function withLine(e: RegistryEntry, line: number): RegistryEntry {
  return { ...e, source: { ...e.source, line } };
}

describe("真仓库：登记表里每一条坐标都对得上", () => {
  const drifts = coordDrifts(REGISTRY, readDoc);

  it("登记表每一条主张登记的行号上，读得到它自己的主张", () => {
    expect(formatDrifts(drifts)).toEqual([]);
  });

  it("取材非空：这条守卫不是在空转", () => {
    // 没有这一发，上面那条可以靠「REGISTRY 是空数组」恒绿 ——
    // 而它读起来和「全部核对通过」逐字一样（那条一次性脚本就踩过这个形状，见它的文件头）。
    expect(REGISTRY.length).toBeGreaterThanOrEqual(13);
    for (const e of REGISTRY) {
      expect(e.source.line, e.id + " 没有登记行号").toBeGreaterThan(0);
      expect(
        String(e.source.sentence).trim().length,
        e.id + " 没有锚点句",
      ).toBeGreaterThan(0);
    }
  });

  it("锚点句在文档里至少命中一处（否则「对得上」是假的）", () => {
    for (const e of REGISTRY) {
      const hits = locateAnchor(readDoc(e.source.doc), e.source.sentence);
      expect(hits.length, e.id + " 的锚点句全文无命中").toBeGreaterThan(0);
    }
  });
});

describe("变异：坐标漂了必须红，且红话说出现在哪", () => {
  const base = REGISTRY[0] as RegistryEntry;

  it("把行号挪到别处 ⇒ 点名这一条，并交出当前命中行", () => {
    const located = locateAnchor(
      readDoc(base.source.doc),
      base.source.sentence,
    );
    const moved = withLine(base, (located[0] as number) + 3);
    const got = coordDrifts([moved], readDoc);
    expect(got.map((d) => d.id)).toEqual([base.id]);
    const msg = formatDrifts(got)[0] as string;
    expect(msg).toContain(base.id);
    expect(msg).toContain(String(located[0]));
  });

  it("行号指向一个与主张无关的行 ⇒ 报「全文无命中」而不是空白", () => {
    const fake = withLine(
      {
        ...base,
        source: {
          ...base.source,
          sentence: "这句话在设计文档里不存在的一个锚点",
        },
      },
      7,
    );
    const got = coordDrifts([fake], readDoc);
    expect(got.length).toBe(1);
    expect(got[0]?.located).toEqual([]);
    expect(formatDrifts(got)[0]).toContain("全文无命中");
  });

  it("锚点句为空 ⇒ 不判成「对任何行都成立」", () => {
    // 空串 `includes` 恒真。若 locateAnchor 不挡，那「锚点句被清空」这种
    // 把判据掏空的做法会让整条守卫恒绿 —— 所以这里要的是 0 命中。
    expect(locateAnchor(["anything", "at all"], "")).toEqual([]);
    const empty = withLine(
      { ...base, source: { ...base.source, sentence: "   " } },
      1,
    );
    expect(coordDrifts([empty], readDoc).length).toBe(1);
  });

  it("同一句话命中多处不算漂，登记行不在其中才算", () => {
    // ⚠ 夹具要连【锚点句】一起换：withLine 只改行号，留着 r1 的真句子配一份合成文档，
    //   判出来的红是「这句话不在这份文档里」而不是我要判的「登记行没命中」——
    //   一次混两种故障，正是本仓在 r1 判据注释里点名的那个形状。
    const doc = ["头", "同一句锚点", "中", "同一句锚点"];
    const synthetic = (): RegistryEntry => ({
      ...base,
      source: { ...base.source, sentence: "同一句锚点" },
    });
    expect(locateAnchor(doc, "同一句锚点")).toEqual([2, 4]);
    expect(coordDrifts([withLine(synthetic(), 4)], () => doc).length).toBe(0);
    expect(coordDrifts([withLine(synthetic(), 1)], () => doc).length).toBe(1);
  });

  it("样式不参与比对：文档带 `code` 与 **粗体**，锚点不带", () => {
    const doc = ["见 `evaluateGate` 那条 **硬规定**"];
    expect(locateAnchor(doc, "见 evaluateGate 那条 硬规定")).toEqual([1]);
    expect(bare("`x` 与 **y**")).toBe("x 与 y");
  });
});
