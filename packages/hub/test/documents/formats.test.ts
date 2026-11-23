import {
  Document as DocxDocument,
  Paragraph as DocxParagraph,
  ExternalHyperlink,
  ImageRun,
  Packer,
  TextRun,
} from "docx";
import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import {
  detectDocumentFormat,
  exportDocument,
  FormatError,
  importDocumentBytes,
} from "../../src/documents/formats.js";

type Primitive = string | number | boolean | null;
type ImportedSheet = {
  name: string;
  rows: Primitive[][];
  styles?: Array<
    Array<{
      bold?: boolean;
      italic?: boolean;
      fill?: string;
      color?: string;
      border?: Record<string, { style: string; color?: string }>;
      numFmt?: string;
      align?: Record<string, unknown>;
    } | null>
  >;
};

function importedSheets(bodyText: string): ImportedSheet[] {
  return (JSON.parse(bodyText) as { sheets: ImportedSheet[] }).sheets;
}

describe("real document format round-trips", () => {
  it("round-trips Markdown as UTF-8 without changing text", async () => {
    const body = "# 标题\n\n中文正文\n";
    const exported = await exportDocument({
      kind: "markdown",
      title: "标题",
      bodyText: body,
      format: "md",
    });
    expect(exported.mime).toBe("text/markdown");
    expect(exported.filename).toBe("标题.md");
    expect(detectDocumentFormat({ buffer: exported.buffer })).toBe("md");
    expect(
      await importDocumentBytes({ buffer: exported.buffer, format: "md" }),
    ).toEqual({
      kind: "markdown",
      bodyText: body,
      mime: "text/markdown",
    });
  });

  it("creates a real DOCX and extracts its paragraphs", async () => {
    const exported = await exportDocument({
      kind: "doc",
      title: "会议纪要",
      bodyText: "第一行\n第二行",
      format: "docx",
    });
    expect(exported.buffer.subarray(0, 2).toString()).toBe("PK");
    expect(
      detectDocumentFormat({
        buffer: exported.buffer,
        filename: "disguised.xlsx",
      }),
    ).toBe("docx");
    const imported = await importDocumentBytes({
      buffer: exported.buffer,
      format: "docx",
    });
    expect(imported.kind).toBe("doc");
    expect(imported.bodyText).toContain("第一行");
    expect(imported.bodyText).toContain("第二行");
  });

  it("creates a real multi-sheet XLSX and preserves primitive cell values", async () => {
    const payload = {
      sheets: [
        {
          name: "Summary",
          rows: [
            ["指标", "值"],
            ["完成", 3],
            ["通过", true],
          ],
        },
        { name: "Notes", rows: [["备注"], ["中文"]] },
      ],
    };
    const exported = await exportDocument({
      kind: "sheet",
      title: "表格",
      bodyText: JSON.stringify(payload),
      format: "xlsx",
    });
    expect(detectDocumentFormat({ buffer: exported.buffer })).toBe("xlsx");
    const imported = await importDocumentBytes({
      buffer: exported.buffer,
      format: "xlsx",
    });
    expect(imported.kind).toBe("sheet");
    const sheets = importedSheets(imported.bodyText);
    expect(sheets.map(({ name, rows }) => ({ name, rows }))).toEqual(
      payload.sheets,
    );
    expect(sheets[0]?.styles?.[0]?.[0]).toMatchObject({
      bold: true,
      border: {
        top: { style: "thin" },
        left: { style: "thin" },
        bottom: { style: "thin" },
        right: { style: "thin" },
      },
    });
  });

  it("round-trips real XLSX formulas, two sheets, and cell styles", async () => {
    const payload = {
      sheets: [
        {
          name: "Calc",
          rows: [
            ["Item", "Amount", "Formula"],
            ["A", 1, "=SUM(B2:B3)"],
            ["B", 2, "=B2*2"],
            ["C", 3, "=SUM(B2:B4)"],
          ],
          styles: [
            [{ fill: "FFD9EAF7", color: "FF1F2937" }, null, null],
            [null, { numFmt: "0.00", italic: true }, null],
            [null, { align: { horizontal: "center" } }, null],
            [null, null, { bold: true }],
          ],
        },
        { name: "Notes", rows: [["Note"], ["中文"]] },
      ],
    };
    const exported = await exportDocument({
      kind: "sheet",
      title: "公式与样式",
      bodyText: JSON.stringify(payload),
      format: "xlsx",
    });
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(exported.buffer as unknown as ArrayBuffer);
    expect(workbook.worksheets.map((sheet) => sheet.name)).toEqual([
      "Calc",
      "Notes",
    ]);
    const calc = workbook.getWorksheet("Calc");
    expect(calc?.getCell("C2").value).toMatchObject({ formula: "SUM(B2:B3)" });
    expect(calc?.getCell("C2").type).toBe(ExcelJS.ValueType.Formula);
    expect(calc?.getCell("B2").value).toBe(1);
    expect(calc?.getCell("A1").font.bold).toBe(true);
    expect(calc?.getCell("C4").border.top?.style).toBe("thin");
    expect(calc?.getCell("A1").fill).toMatchObject({
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: "FFD9EAF7" },
    });
    expect(calc?.getCell("B2").numFmt).toBe("0.00");

    const imported = await importDocumentBytes({
      buffer: exported.buffer,
      format: "xlsx",
    });
    const sheets = importedSheets(imported.bodyText);
    expect(sheets.map(({ name, rows }) => ({ name, rows }))).toEqual(
      payload.sheets.map(({ name, rows }) => ({ name, rows })),
    );
    expect(sheets[0]?.styles?.[0]?.[0]).toMatchObject({
      bold: true,
      fill: "FFD9EAF7",
      color: "FF1F2937",
    });
    expect(sheets[0]?.styles?.[1]?.[1]).toMatchObject({
      italic: true,
      numFmt: "0.00",
    });
    expect(sheets[0]?.styles?.[2]?.[1]?.align).toMatchObject({
      horizontal: "center",
    });

    const exportedAgain = await exportDocument({
      kind: "sheet",
      title: "公式与样式",
      bodyText: imported.bodyText,
      format: "xlsx",
    });
    const workbookAgain = new ExcelJS.Workbook();
    await workbookAgain.xlsx.load(
      exportedAgain.buffer as unknown as ArrayBuffer,
    );
    const calcAgain = workbookAgain.getWorksheet("Calc");
    expect(calcAgain?.getCell("C2").value).toMatchObject({
      formula: "SUM(B2:B3)",
    });
    expect(calcAgain?.getCell("C3").value).toMatchObject({ formula: "B2*2" });
    expect(calcAgain?.getCell("A1").fill).toMatchObject({
      fgColor: { argb: "FFD9EAF7" },
    });
    expect(calcAgain?.getCell("B2").font.italic).toBe(true);
    expect(calcAgain?.getCell("B2").numFmt).toBe("0.00");
    expect(calcAgain?.getCell("B3").alignment.horizontal).toBe("center");
    expect(workbookAgain.getWorksheet("Notes")?.getCell("A2").value).toBe(
      "中文",
    );
  });

  it("expands imported shared formulas into readable per-cell formulas", async () => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Shared");
    sheet.getCell("A1").value = 1;
    sheet.fillFormula("A2:A3", "A1+1", [2, 3]);
    const buffer = await workbook.xlsx.writeBuffer();
    const imported = await importDocumentBytes({
      buffer: Buffer.from(buffer),
      format: "xlsx",
    });
    expect(importedSheets(imported.bodyText)[0]?.rows).toEqual([
      [1],
      ["=A1+1"],
      ["=A2+1"],
    ]);
  });

  it("round-trips DOCX headings, emphasis, links, lists, and tables", async () => {
    const html =
      "<h1>会议纪要</h1><p><strong>粗体</strong> <em>斜体</em> <u>下划线</u> " +
      '<a href="https://example.com/path?q=1" title="链接">链接</a></p>' +
      "<ul><li>项目一</li><li>项目二</li></ul>" +
      "<ol><li>第一项</li><li>第二项</li></ol>" +
      "<table><thead><tr><th>名称</th><th>状态</th></tr></thead>" +
      "<tbody><tr><td>导出</td><td>通过</td></tr></tbody></table>";
    const exported = await exportDocument({
      kind: "doc",
      title: "富文本",
      bodyText: html,
      format: "docx",
    });
    const imported = await importDocumentBytes({
      buffer: exported.buffer,
      format: "docx",
    });
    expect(imported.bodyText).toContain("<h1>会议纪要</h1>");
    expect(imported.bodyText).toContain("<strong>粗体</strong>");
    expect(imported.bodyText).toContain("<em>斜体</em>");
    expect(imported.bodyText).toContain("<u>下划线</u>");
    expect(imported.bodyText).toContain("<a ");
    expect(imported.bodyText).toContain('href="https://example.com/path?q=1"');
    expect(imported.bodyText).toContain("<ul>");
    expect(imported.bodyText).toContain("<ol>");
    expect(imported.bodyText).toContain("<li>项目一</li>");
    expect(imported.bodyText).toContain("<li>第一项</li>");
    expect(imported.bodyText).toContain("<table>");
    expect(imported.bodyText).toContain("名称");
    expect(imported.bodyText).toContain("通过");

    const exportedAgain = await exportDocument({
      kind: "doc",
      title: "富文本",
      bodyText: imported.bodyText,
      format: "docx",
    });
    const importedAgain = await importDocumentBytes({
      buffer: exportedAgain.buffer,
      format: "docx",
    });
    expect(importedAgain.bodyText).toContain("<strong>粗体</strong>");
    expect(importedAgain.bodyText).toContain("<ol>");
    expect(importedAgain.bodyText).toContain("第一项");
    expect(importedAgain.bodyText).toContain("<table>");
  });

  it("sanitizes DOCX HTML before export and after import", async () => {
    const exported = await exportDocument({
      kind: "doc",
      title: "清洗",
      bodyText:
        '<h1 onclick="steal()">安全标题</h1><p onmouseover="steal()">' +
        '<strong>保留粗体</strong><script>alert("xss")</script>' +
        '<a href="javascript:alert(1)" onclick="steal()">坏链接</a>' +
        '<img src="javascript:alert(2)" alt="坏图片"></p>',
      format: "docx",
    });
    const imported = await importDocumentBytes({
      buffer: exported.buffer,
      format: "docx",
    });
    expect(imported.bodyText).toContain("安全标题");
    expect(imported.bodyText).toContain("<strong>保留粗体</strong>");
    expect(imported.bodyText).toContain("坏链接");
    expect(imported.bodyText).not.toContain("<script");
    expect(imported.bodyText).not.toContain("alert");
    expect(imported.bodyText).not.toContain("onclick");
    expect(imported.bodyText).not.toContain("onmouseover");
    expect(imported.bodyText).not.toContain("javascript:");
    expect(imported.bodyText).not.toContain("<img");

    const unsafeDocument = new DocxDocument({
      sections: [
        {
          children: [
            new DocxParagraph({
              children: [
                new ExternalHyperlink({
                  link: "javascript:alert(1)",
                  children: [new TextRun("导入坏链接")],
                }),
              ],
            }),
          ],
        },
      ],
    });
    const importedUnsafe = await importDocumentBytes({
      buffer: await Packer.toBuffer(unsafeDocument),
      format: "docx",
    });
    expect(importedUnsafe.bodyText).toContain("导入坏链接");
    expect(importedUnsafe.bodyText).not.toContain("javascript:");
    expect(importedUnsafe.bodyText).not.toContain("href=");
  });

  it("rejects mammoth data-URL images instead of silently dropping them", async () => {
    await expect(
      exportDocument({
        kind: "doc",
        title: "图片",
        bodyText:
          '<p>图片</p><img src="data:image/png;base64,iVBORw0KGgo=" alt="pixel">',
        format: "docx",
      }),
    ).rejects.toMatchObject({ code: "invalid_docx" });

    const image = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nWQAAAAASUVORK5CYII=",
      "base64",
    );
    const document = new DocxDocument({
      sections: [
        {
          children: [
            new DocxParagraph({
              children: [
                new ImageRun({
                  type: "png",
                  data: image,
                  transformation: { width: 1, height: 1 },
                }),
              ],
            }),
          ],
        },
      ],
    });
    await expect(
      importDocumentBytes({
        buffer: await Packer.toBuffer(document),
        format: "docx",
      }),
    ).rejects.toMatchObject({ code: "invalid_docx" });
  });

  it("keeps Markdown-like and plain DOCX bodies as plain paragraphs", async () => {
    const body = "# 标题\n\n- 项目\n正文\n<https://example.com>\n1 < 2 & 3";
    const exported = await exportDocument({
      kind: "doc",
      title: "旧行为",
      bodyText: body,
      format: "docx",
    });
    const imported = await importDocumentBytes({
      buffer: exported.buffer,
      format: "docx",
    });
    expect(imported.bodyText).toContain("# 标题");
    expect(imported.bodyText).toContain("- 项目");
    expect(imported.bodyText).toContain("正文");
    expect(imported.bodyText).toContain("&lt;https://example.com&gt;");
    expect(imported.bodyText).toContain("1 &lt; 2 &amp; 3");
    expect(imported.bodyText).not.toContain("<h1>");
    expect(imported.bodyText).not.toContain("<ul>");
  });

  it("creates a real PDF with Chinese glyphs and imports the text back", async () => {
    const exported = await exportDocument({
      kind: "doc",
      title: "中文 PDF",
      bodyText: "群角色上层\n会议结论：通过",
      format: "pdf",
    });
    expect(exported.mime).toBe("application/pdf");
    expect(exported.buffer.subarray(0, 5).toString()).toBe("%PDF-");
    expect(detectDocumentFormat({ buffer: exported.buffer })).toBe("pdf");
    const imported = await importDocumentBytes({
      buffer: exported.buffer,
      format: "pdf",
    });
    expect(imported.bodyText.replace(/\s+/gu, "")).toContain("群角色上层");
    expect(imported.bodyText.replace(/\s+/gu, "")).toContain("会议结论：通过");
  });
});

describe("format rejection paths", () => {
  it("rejects signature/format mismatches, NUL text, and XLSX for non-sheet documents", async () => {
    await expect(
      importDocumentBytes({ buffer: Buffer.from("# md"), format: "docx" }),
    ).rejects.toMatchObject({ code: "format_mismatch" });
    expect(() =>
      detectDocumentFormat({ buffer: Buffer.from([0, 1, 2]) }),
    ).toThrow(FormatError);
    await expect(
      exportDocument({
        kind: "doc",
        title: "Doc",
        bodyText: "text",
        format: "xlsx",
      }),
    ).rejects.toMatchObject({ code: "kind_mismatch" });
  });

  it("rejects malformed sheet JSON instead of generating a misleading workbook", async () => {
    await expect(
      exportDocument({
        kind: "sheet",
        title: "Sheet",
        bodyText: "{}",
        format: "xlsx",
      }),
    ).rejects.toMatchObject({ code: "invalid_sheet" });
  });
});
