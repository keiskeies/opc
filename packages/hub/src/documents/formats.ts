/**
 * T9 真实格式转换：外部字节与文档中心 body_text 之间的唯一转换层。
 *
 * 检测先看文件签名，不信上传文件名；导入保留可机读正文，导出则必须生成
 * 能被第三方软件打开的真文件。PDF 不使用仅覆盖拉丁字符的标准字体，中文缺字体
 * 时明确失败，避免导出一份看似成功、实际丢字的文件。
 */
import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import {
  type DocExportFormat,
  type DocKind,
  MAX_DOC_BODY_CHARS,
} from "@opc/contracts";
import fontkit from "@pdf-lib/fontkit";
import {
  AlignmentType,
  BorderStyle,
  Document,
  ExternalHyperlink,
  HeadingLevel,
  InternalHyperlink,
  type IParagraphPropertiesOptionsBase,
  LevelFormat,
  type NumberingDefinition,
  Packer,
  Paragraph,
  type ParagraphChild,
  Table,
  TableCell,
  TableRow,
  TextRun,
} from "docx";
import ExcelJS from "exceljs";
import mammoth from "mammoth";
import { type DefaultTreeAdapterTypes, parseFragment } from "parse5";
import { PDFDocument, type PDFFont, type PDFPage } from "pdf-lib";
import { getDocument as getPdfDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import sanitizeHtml from "sanitize-html";

export type DocumentFormat = "docx" | "xlsx" | "pdf" | "md";

export type FormatErrorCode =
  | "invalid_buffer"
  | "too_large"
  | "nul_detected"
  | "invalid_utf8"
  | "unsupported_format"
  | "invalid_archive"
  | "format_mismatch"
  | "invalid_docx"
  | "invalid_xlsx"
  | "invalid_pdf"
  | "invalid_sheet"
  | "invalid_body"
  | "invalid_title"
  | "kind_mismatch"
  | "font_unavailable";

export class FormatError extends Error {
  readonly code: FormatErrorCode;

  constructor(code: FormatErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "FormatError";
    this.code = code;
  }
}

type Primitive = string | number | boolean | null;
type SheetBorderSide = {
  readonly style: ExcelJS.BorderStyle;
  readonly color?: string;
};
type SheetBorder = Partial<
  Record<"top" | "left" | "bottom" | "right", SheetBorderSide>
>;
type SheetAlignment = Partial<ExcelJS.Alignment>;
type SheetCellStyle = {
  readonly bold?: boolean;
  readonly italic?: boolean;
  readonly fill?: string;
  readonly color?: string;
  readonly border?: SheetBorder | ExcelJS.BorderStyle;
  readonly numFmt?: string;
  readonly align?: SheetAlignment;
};
type SheetPayload = {
  readonly sheets: ReadonlyArray<{
    readonly name: string;
    readonly rows: ReadonlyArray<readonly Primitive[]>;
    readonly styles?: ReadonlyArray<ReadonlyArray<SheetCellStyle | null>>;
  }>;
};
type HtmlNode = DefaultTreeAdapterTypes.ChildNode;
type HtmlElement = DefaultTreeAdapterTypes.Element;

const MAX_INPUT_BYTES = 50 * 1024 * 1024;
const MAX_PDF_PAGES = 10_000;
const MAX_SHEET_ROWS = 100_000;
const MAX_SHEET_COLUMNS = 16_384;
const ZIP_LOCAL_SIGNATURE = 0x04034b50;
const ZIP_CENTRAL_SIGNATURE = 0x02014b50;
const ZIP_END_SIGNATURE = 0x06054b50;
const DOCX_MEMBER = "word/document.xml";
const XLSX_MEMBER = "xl/workbook.xml";

const MIME_BY_FORMAT: Record<DocumentFormat, string> = {
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pdf: "application/pdf",
  md: "text/markdown",
};

const EXTENSION_BY_FORMAT: Record<string, DocumentFormat> = {
  docx: "docx",
  xlsx: "xlsx",
  pdf: "pdf",
  md: "md",
  markdown: "md",
  txt: "md",
};

const MIME_FORMATS: Readonly<Record<string, DocumentFormat>> = {
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
    "docx",
  "application/vnd.ms-word.document.macroenabled.12": "docx",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "application/vnd.ms-excel.sheet.macroenabled.12": "xlsx",
  "application/pdf": "pdf",
  "text/markdown": "md",
  "text/x-markdown": "md",
  "text/plain": "md",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function assertBuffer(buffer: Buffer): void {
  if (!Buffer.isBuffer(buffer)) {
    throw new FormatError("invalid_buffer", "文档输入必须是 Buffer。");
  }
  if (buffer.length > MAX_INPUT_BYTES) {
    throw new FormatError(
      "too_large",
      `文档字节超过 ${MAX_INPUT_BYTES} 字节上限，拒绝解析。`,
    );
  }
}

function hasPkSignature(buffer: Buffer): boolean {
  if (buffer.length < 2 || buffer[0] !== 0x50 || buffer[1] !== 0x4b) {
    return false;
  }
  if (buffer.length < 4) {
    throw new FormatError("invalid_archive", "PK 文件头不完整。");
  }
  const signature = buffer.readUInt32LE(0);
  if (
    signature !== ZIP_LOCAL_SIGNATURE &&
    signature !== ZIP_CENTRAL_SIGNATURE &&
    signature !== ZIP_END_SIGNATURE &&
    signature !== 0x08074b50
  ) {
    throw new FormatError(
      "invalid_archive",
      "PK 文件签名不是受支持的 ZIP 记录。",
    );
  }
  return true;
}

/** 只读 ZIP 中央目录，不解压、不执行外来对象，也能识别伪装扩展名的 OOXML。 */
function inspectOfficeArchive(buffer: Buffer): "docx" | "xlsx" {
  const end = buffer.lastIndexOf(
    Buffer.from([0x50, 0x4b, 0x05, 0x06]),
    buffer.length - 22,
  );
  if (end < 0 || end + 22 > buffer.length) {
    throw new FormatError("invalid_archive", "ZIP 缺少可读的中央目录尾记录。");
  }
  const entries = buffer.readUInt16LE(end + 10);
  const directoryOffset = buffer.readUInt32LE(end + 16);
  if (entries === 0xffff || directoryOffset === 0xffffffff) {
    throw new FormatError(
      "invalid_archive",
      "暂不支持含 ZIP64 中央目录的文档。",
    );
  }
  let cursor = directoryOffset;
  let docx = false;
  let xlsx = false;
  for (let index = 0; index < entries; index += 1) {
    if (cursor + 46 > buffer.length || cursor < 0) {
      throw new FormatError("invalid_archive", "ZIP 中央目录越界。");
    }
    if (buffer.readUInt32LE(cursor) !== ZIP_CENTRAL_SIGNATURE) {
      throw new FormatError("invalid_archive", "ZIP 中央目录项签名无效。");
    }
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const nameStart = cursor + 46;
    const nameEnd = nameStart + nameLength;
    const next = nameEnd + extraLength + commentLength;
    if (nameEnd > buffer.length || next > buffer.length || next <= cursor) {
      throw new FormatError("invalid_archive", "ZIP 中央目录文件名越界。");
    }
    const name = buffer.toString("utf8", nameStart, nameEnd);
    if (name === DOCX_MEMBER) docx = true;
    if (name === XLSX_MEMBER) xlsx = true;
    cursor = next;
  }
  if (docx === xlsx) {
    throw new FormatError(
      "invalid_archive",
      "ZIP 不是受支持的 DOCX/XLSX：未唯一找到 word/document.xml 或 xl/workbook.xml。",
    );
  }
  return docx ? "docx" : "xlsx";
}

function hintedFormat(filename?: string, mime?: string): DocumentFormat {
  if (filename !== undefined) {
    const extension = extname(filename).slice(1).toLowerCase();
    const byExtension = EXTENSION_BY_FORMAT[extension];
    if (byExtension !== undefined) return byExtension;
  }
  if (mime !== undefined) {
    const normalized = mime.split(";", 1)[0]?.trim().toLowerCase() ?? "";
    const byMime = MIME_FORMATS[normalized];
    if (byMime !== undefined) return byMime;
  }
  return "md";
}

function decodeMarkdown(buffer: Buffer): string {
  if (buffer.includes(0)) {
    throw new FormatError(
      "nul_detected",
      "Markdown/文本含有 NUL 字节，拒绝按 UTF-8 导入。",
    );
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch (error) {
    throw new FormatError("invalid_utf8", "Markdown 必须是合法 UTF-8 文本。", {
      cause: error,
    });
  }
}

export function detectDocumentFormat(input: {
  buffer: Buffer;
  filename?: string;
  mime?: string;
}): DocumentFormat {
  if (!isRecord(input) || !Buffer.isBuffer(input.buffer)) {
    throw new FormatError("invalid_buffer", "文档输入必须是含 Buffer 的对象。");
  }
  const buffer = input.buffer;
  assertBuffer(buffer);
  if (
    buffer.length >= 5 &&
    buffer[0] === 0x25 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x44 &&
    buffer[3] === 0x46 &&
    buffer[4] === 0x2d
  ) {
    return "pdf";
  }
  if (hasPkSignature(buffer)) return inspectOfficeArchive(buffer);
  if (buffer.includes(0)) {
    throw new FormatError(
      "nul_detected",
      "文档不是受支持的二进制签名，且含有 NUL 字节。",
    );
  }
  const format = hintedFormat(input.filename, input.mime);
  if (format === "md") decodeMarkdown(buffer);
  return format;
}

function assertBodyText(bodyText: string): void {
  if (typeof bodyText !== "string") {
    throw new FormatError("invalid_body", "文档正文必须是字符串。");
  }
  if (bodyText.includes("\0")) {
    throw new FormatError("invalid_body", "文档正文不能含有 NUL 字符。");
  }
  if (bodyText.length > MAX_DOC_BODY_CHARS) {
    throw new FormatError(
      "too_large",
      `文档正文超过 ${MAX_DOC_BODY_CHARS} 字符上限。`,
    );
  }
}

function primitiveCell(value: unknown, cell?: ExcelJS.Cell): Primitive {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new FormatError("invalid_xlsx", "XLSX 含非有限数值单元格。");
    }
    return value;
  }
  if (value instanceof Date) {
    if (!Number.isFinite(value.getTime())) {
      throw new FormatError("invalid_xlsx", "XLSX 含无效日期单元格。");
    }
    return value.toISOString();
  }
  if (isRecord(value)) {
    if ("richText" in value && Array.isArray(value.richText)) {
      return value.richText
        .map((part) => {
          if (!isRecord(part) || typeof part.text !== "string") {
            throw new FormatError(
              "invalid_xlsx",
              "XLSX 富文本单元格形状无效。",
            );
          }
          return part.text;
        })
        .join("");
    }
    if ("hyperlink" in value && typeof value.hyperlink === "string") {
      return typeof value.text === "string" ? value.text : value.hyperlink;
    }
    if ("error" in value && typeof value.error === "string") return value.error;
    if ("formula" in value || "sharedFormula" in value) {
      const formula =
        cell?.formula ??
        ("formula" in value ? value.formula : value.sharedFormula);
      if (typeof formula !== "string") {
        throw new FormatError("invalid_xlsx", "XLSX 公式单元格形状无效。");
      }
      // cell.formula 会把共享公式按从表位置翻译成每个单元格自己的可读公式。
      return `=${formula}`;
    }
  }
  throw new FormatError("invalid_xlsx", "XLSX 含无法序列化为原始值的单元格。");
}

function stableExcelColor(color: Partial<ExcelJS.Color> | undefined) {
  return typeof color?.argb === "string" && /^[0-9a-f]{8}$/iu.test(color.argb)
    ? color.argb.toUpperCase()
    : undefined;
}

function stableExcelBorder(
  border: Partial<ExcelJS.Style>["border"],
): SheetBorder | undefined {
  const result: {
    top?: SheetBorderSide;
    left?: SheetBorderSide;
    bottom?: SheetBorderSide;
    right?: SheetBorderSide;
  } = {};
  for (const side of ["top", "left", "bottom", "right"] as const) {
    const value = border?.[side];
    if (
      typeof value?.style !== "string" ||
      !EXCEL_BORDER_STYLES.has(value.style)
    ) {
      continue;
    }
    const color = stableExcelColor(value.color);
    result[side] = {
      style: value.style,
      ...(color === undefined ? {} : { color }),
    };
  }
  return Object.keys(result).length === 0 ? undefined : result;
}

function stableExcelAlignment(
  alignment: Partial<ExcelJS.Alignment> | undefined,
): SheetAlignment | undefined {
  if (alignment === undefined) return undefined;
  const result: SheetAlignment = {};
  if (
    typeof alignment.horizontal === "string" &&
    EXCEL_HORIZONTAL_ALIGNMENTS.has(alignment.horizontal)
  ) {
    result.horizontal = alignment.horizontal as ExcelJS.Alignment["horizontal"];
  }
  if (
    typeof alignment.vertical === "string" &&
    EXCEL_VERTICAL_ALIGNMENTS.has(alignment.vertical)
  ) {
    result.vertical = alignment.vertical as ExcelJS.Alignment["vertical"];
  }
  if (typeof alignment.wrapText === "boolean") {
    result.wrapText = alignment.wrapText;
  }
  if (typeof alignment.shrinkToFit === "boolean") {
    result.shrinkToFit = alignment.shrinkToFit;
  }
  if (
    typeof alignment.indent === "number" &&
    Number.isInteger(alignment.indent) &&
    alignment.indent >= 0 &&
    alignment.indent <= 250
  ) {
    result.indent = alignment.indent;
  }
  if (alignment.readingOrder === "rtl" || alignment.readingOrder === "ltr") {
    result.readingOrder = alignment.readingOrder;
  }
  if (
    alignment.textRotation === "vertical" ||
    (typeof alignment.textRotation === "number" &&
      Number.isInteger(alignment.textRotation) &&
      alignment.textRotation >= -90 &&
      alignment.textRotation <= 90)
  ) {
    result.textRotation = alignment.textRotation;
  }
  return Object.keys(result).length === 0 ? undefined : result;
}

function excelCellStyle(style: Partial<ExcelJS.Style>): SheetCellStyle | null {
  const fill =
    style.fill?.type === "pattern" && style.fill.pattern === "solid"
      ? stableExcelColor(style.fill.fgColor)
      : undefined;
  const color = stableExcelColor(style.font?.color);
  const border = stableExcelBorder(style.border);
  const align = stableExcelAlignment(style.alignment);
  const bold =
    typeof style.font?.bold === "boolean" ? style.font.bold : undefined;
  const italic =
    typeof style.font?.italic === "boolean" ? style.font.italic : undefined;
  const numFmt =
    typeof style.numFmt === "string" && style.numFmt !== "General"
      ? style.numFmt
      : undefined;
  if (
    bold === undefined &&
    italic === undefined &&
    fill === undefined &&
    color === undefined &&
    border === undefined &&
    align === undefined &&
    numFmt === undefined
  ) {
    return null;
  }
  return {
    ...(bold === undefined ? {} : { bold }),
    ...(italic === undefined ? {} : { italic }),
    ...(fill === undefined ? {} : { fill }),
    ...(color === undefined ? {} : { color }),
    ...(border === undefined ? {} : { border }),
    ...(numFmt === undefined ? {} : { numFmt }),
    ...(align === undefined ? {} : { align }),
  };
}

async function importXlsx(buffer: Buffer): Promise<string> {
  try {
    const workbook = new ExcelJS.Workbook();
    // ExcelJS 4.4 的声明把 Buffer 误写成 ArrayBuffer；运行时仍接收 Node Buffer。
    await workbook.xlsx.load(buffer as unknown as ArrayBuffer);
    const sheets = workbook.worksheets.map((worksheet) => {
      const rows: Primitive[][] = [];
      const styles: Array<Array<SheetCellStyle | null>> = [];
      worksheet.eachRow({ includeEmpty: true }, (row) => {
        if (!Array.isArray(row.values)) {
          throw new FormatError(
            "invalid_xlsx",
            "XLSX 行不是可序列化的单元格数组。",
          );
        }
        const values = row.values.slice(1) as unknown[];
        const primitiveRow = Array.from(values, (value, columnIndex) =>
          primitiveCell(value, row.getCell(columnIndex + 1)),
        );
        rows.push(primitiveRow);
        styles.push(
          primitiveRow.map((_, columnIndex) =>
            excelCellStyle(row.getCell(columnIndex + 1).style),
          ),
        );
      });
      if (rows.length > MAX_SHEET_ROWS) {
        throw new FormatError(
          "too_large",
          `XLSX 单表超过 ${MAX_SHEET_ROWS} 行，拒绝导入。`,
        );
      }
      for (const row of rows) {
        if (row.length > MAX_SHEET_COLUMNS) {
          throw new FormatError(
            "too_large",
            `XLSX 单表超过 ${MAX_SHEET_COLUMNS} 列，拒绝导入。`,
          );
        }
      }
      const hasStyles = styles.some((row) => row.some(Boolean));
      return {
        name: worksheet.name,
        rows,
        ...(hasStyles ? { styles } : {}),
      };
    });
    const bodyText = JSON.stringify({ sheets });
    assertBodyText(bodyText);
    return bodyText;
  } catch (error) {
    if (error instanceof FormatError) throw error;
    throw new FormatError("invalid_xlsx", "XLSX 解析失败，文件可能已损坏。", {
      cause: error,
    });
  }
}

const DOC_HTML_TAGS = [
  "p",
  "br",
  "div",
  "span",
  "b",
  "strong",
  "i",
  "em",
  "u",
  "s",
  "strike",
  "del",
  "h1",
  "h2",
  "h3",
  "h4",
  "ul",
  "ol",
  "li",
  "blockquote",
  "pre",
  "code",
  "a",
  "img",
  "table",
  "thead",
  "tbody",
  "tr",
  "th",
  "td",
  "hr",
];
const DOC_ASSET_SOURCE = /^\/api\/v1\/assets\/[A-Za-z0-9_-]+$/u;
const DOC_LINK_SOURCE = /^(?:https?:\/\/|mailto:|#)/iu;

function allowedDocLink(value: string | undefined): value is string {
  return value !== undefined && DOC_LINK_SOURCE.test(value);
}

/** 与前端 sanitizedDocFragment 同源的白名单；图片无法落资产时明确拒绝。 */
function sanitizeDocHtml(html: string): string {
  return sanitizeHtml(html, {
    allowedTags: DOC_HTML_TAGS,
    allowedAttributes: {
      "*": ["title"],
      a: ["href", "target", "rel"],
      img: ["src", "alt"],
      td: ["colspan", "rowspan"],
      th: ["colspan", "rowspan"],
    },
    allowedSchemes: ["http", "https", "mailto"],
    allowProtocolRelative: false,
    nonTextTags: ["script", "style", "textarea", "option"],
    nestingLimit: 100,
    transformTags: {
      a: (tagName, attribs) => {
        const clean: Record<string, string> = {
          target: "_blank",
          rel: "noreferrer noopener",
        };
        if (allowedDocLink(attribs.href)) clean.href = attribs.href;
        if (attribs.title !== undefined) clean.title = attribs.title;
        return { tagName, attribs: clean };
      },
      img: (tagName, attribs) => {
        const source = attribs.src?.trim() ?? "";
        let compact = "";
        for (const character of source) {
          const codePoint = character.codePointAt(0);
          if (codePoint !== undefined && codePoint > 32) compact += character;
        }
        if (/^data:image\//iu.test(compact)) {
          throw new FormatError(
            "invalid_docx",
            "DOCX 含 mammoth/data URL 内嵌图片；当前资产契约只接受 /api/v1/assets 资产，拒绝静默丢图。",
          );
        }
        if (source !== "" && !DOC_ASSET_SOURCE.test(source)) {
          if (/^(?:javascript|vbscript|file):/iu.test(compact)) {
            return { tagName, attribs: {} };
          }
          throw new FormatError(
            "invalid_docx",
            "DOCX 图片必须引用已导入的 /api/v1/assets 资产，拒绝静默丢失外部图片。",
          );
        }
        return {
          tagName,
          attribs: {
            ...(source === "" ? {} : { src: source }),
            ...(attribs.alt === undefined ? {} : { alt: attribs.alt }),
          },
        };
      },
    },
    exclusiveFilter: (frame) =>
      frame.tag === "img" && frame.attribs.src === undefined,
  });
}

function isHtmlElement(
  node: DefaultTreeAdapterTypes.Node | null,
): node is HtmlElement {
  return node !== null && "tagName" in node;
}

function htmlAttribute(node: HtmlElement, name: string): string | undefined {
  return node.attrs.find((attribute) => attribute.name === name)?.value;
}

type InlineFormat = {
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
  font?: string;
  hyperlink?: boolean;
};

function runFormatting(format: InlineFormat) {
  return {
    ...(format.bold === undefined ? {} : { bold: format.bold }),
    ...(format.italic === undefined ? {} : { italics: format.italic }),
    ...(format.underline === undefined
      ? {}
      : { underline: format.underline ? {} : false }),
    ...(format.strike === undefined ? {} : { strike: format.strike }),
    ...(format.font === undefined ? {} : { font: format.font }),
    ...(format.hyperlink ? { style: "Hyperlink" } : {}),
  };
}

function textRuns(text: string, format: InlineFormat): TextRun[] {
  const formatting = runFormatting(format);
  return text.split(/\r\n|\r|\n/u).map(
    (line, index) =>
      new TextRun({
        ...formatting,
        text: line,
        ...(index === 0 ? {} : { break: 1 }),
      }),
  );
}

function inlineHtmlChildren(
  nodes: readonly HtmlNode[],
  format: InlineFormat = {},
): ParagraphChild[] {
  const children: ParagraphChild[] = [];
  for (const node of nodes) {
    if ("value" in node) {
      children.push(...textRuns(node.value, format));
      continue;
    }
    if (!isHtmlElement(node)) continue;
    switch (node.tagName) {
      case "b":
      case "strong":
        children.push(
          ...inlineHtmlChildren(node.childNodes, { ...format, bold: true }),
        );
        break;
      case "i":
      case "em":
        children.push(
          ...inlineHtmlChildren(node.childNodes, { ...format, italic: true }),
        );
        break;
      case "u":
        children.push(
          ...inlineHtmlChildren(node.childNodes, {
            ...format,
            underline: true,
          }),
        );
        break;
      case "s":
      case "strike":
      case "del":
        children.push(
          ...inlineHtmlChildren(node.childNodes, { ...format, strike: true }),
        );
        break;
      case "code":
        children.push(
          ...inlineHtmlChildren(node.childNodes, {
            ...format,
            font: "Consolas",
          }),
        );
        break;
      case "br":
        children.push(new TextRun({ ...runFormatting(format), break: 1 }));
        break;
      case "a": {
        const link = allowedDocLink(htmlAttribute(node, "href"))
          ? htmlAttribute(node, "href")
          : undefined;
        const linkChildren = inlineHtmlChildren(node.childNodes, {
          ...format,
          hyperlink: true,
        });
        if (link === undefined || link === "#") {
          children.push(...linkChildren);
        } else if (link.startsWith("#")) {
          children.push(
            new InternalHyperlink({
              anchor: link.slice(1),
              children: linkChildren,
            }),
          );
        } else {
          children.push(
            new ExternalHyperlink({ link, children: linkChildren }),
          );
        }
        break;
      }
      case "img":
        throw new FormatError(
          "invalid_docx",
          "DOCX 导出不能内联网址图片；请先上传为 /api/v1/assets 资产并提供可读取的资产字节。",
        );
      default:
        children.push(...inlineHtmlChildren(node.childNodes, format));
    }
  }
  return children;
}

type HtmlDocxContext = {
  numbering: NumberingDefinition[];
  nextList: number;
};

function paragraphFromHtml(
  nodes: readonly HtmlNode[],
  properties: IParagraphPropertiesOptionsBase = {},
  format: InlineFormat = {},
): Paragraph {
  return new Paragraph({
    ...properties,
    children: inlineHtmlChildren(nodes, format),
  });
}

function htmlSpan(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const span = Number(value);
  return Number.isSafeInteger(span) && span > 0 && span <= 1000
    ? span
    : undefined;
}

function htmlTableRows(table: HtmlElement): HtmlElement[] {
  const rows: HtmlElement[] = [];
  for (const child of table.childNodes) {
    if (!isHtmlElement(child)) continue;
    if (child.tagName === "tr") rows.push(child);
    else if (child.tagName === "thead" || child.tagName === "tbody") {
      rows.push(
        ...child.childNodes.filter(
          (node): node is HtmlElement =>
            isHtmlElement(node) && node.tagName === "tr",
        ),
      );
    }
  }
  return rows;
}

function htmlTable(
  table: HtmlElement,
  context: HtmlDocxContext,
): Table | undefined {
  const rows = htmlTableRows(table).map((row) => {
    const cells = row.childNodes
      .filter(
        (node): node is HtmlElement =>
          isHtmlElement(node) &&
          (node.tagName === "td" || node.tagName === "th"),
      )
      .map((cell) => {
        const columnSpan = htmlSpan(htmlAttribute(cell, "colspan"));
        const rowSpan = htmlSpan(htmlAttribute(cell, "rowspan"));
        const children = htmlBlocks(cell.childNodes, context);
        return new TableCell({
          children: children.length === 0 ? [new Paragraph("")] : children,
          ...(columnSpan === undefined ? {} : { columnSpan }),
          ...(rowSpan === undefined ? {} : { rowSpan }),
        });
      });
    return new TableRow({
      children:
        cells.length === 0
          ? [new TableCell({ children: [new Paragraph("")] })]
          : cells,
      ...(isHtmlElement(row.parentNode) && row.parentNode.tagName === "thead"
        ? { tableHeader: true }
        : {}),
    });
  });
  return rows.length === 0 ? undefined : new Table({ rows });
}

function htmlList(
  list: HtmlElement,
  context: HtmlDocxContext,
  level: number,
): Array<Paragraph | Table> {
  const ordered = list.tagName === "ol";
  const listLevel = Math.min(level, 8);
  const reference = ordered ? `html-list-${context.nextList++}` : "";
  if (ordered) {
    context.numbering.push({
      reference,
      levels: Array.from({ length: 9 }, (_, index) => ({
        level: index,
        format: LevelFormat.DECIMAL,
        text: `%${index + 1}.`,
        alignment: AlignmentType.LEFT,
      })),
    });
  }
  const paragraphs: Array<Paragraph | Table> = [];
  for (const item of list.childNodes) {
    if (!isHtmlElement(item) || item.tagName !== "li") continue;
    const content = item.childNodes.filter(
      (node) =>
        !isHtmlElement(node) ||
        (node.tagName !== "ul" && node.tagName !== "ol"),
    );
    const properties: IParagraphPropertiesOptionsBase = ordered
      ? { numbering: { reference, level: listLevel } }
      : { bullet: { level: listLevel } };
    const itemParagraphs = htmlBlocks(content, context, properties);
    paragraphs.push(
      ...(itemParagraphs.length === 0
        ? [new Paragraph({ ...properties, children: [] })]
        : itemParagraphs),
    );
    for (const nested of item.childNodes) {
      if (
        isHtmlElement(nested) &&
        (nested.tagName === "ul" || nested.tagName === "ol")
      ) {
        paragraphs.push(...htmlList(nested, context, level + 1));
      }
    }
  }
  return paragraphs;
}

const HTML_BLOCK_TAGS = new Set([
  "p",
  "div",
  "h1",
  "h2",
  "h3",
  "h4",
  "blockquote",
  "pre",
  "ul",
  "ol",
  "table",
  "hr",
]);

function htmlBlocks(
  nodes: readonly HtmlNode[],
  context: HtmlDocxContext,
  properties: IParagraphPropertiesOptionsBase = {},
): Array<Paragraph | Table> {
  const blocks: Array<Paragraph | Table> = [];
  let inline: HtmlNode[] = [];
  const flush = () => {
    if (inline.length === 0) return;
    blocks.push(paragraphFromHtml(inline, properties));
    inline = [];
  };
  for (const node of nodes) {
    if ("value" in node && node.value.trim() === "") continue;
    if (!isHtmlElement(node) || !HTML_BLOCK_TAGS.has(node.tagName)) {
      inline.push(node);
      continue;
    }
    flush();
    switch (node.tagName) {
      case "p":
        blocks.push(paragraphFromHtml(node.childNodes, properties));
        break;
      case "div":
        blocks.push(...htmlBlocks(node.childNodes, context, properties));
        if (node.childNodes.length === 0) {
          blocks.push(new Paragraph({ ...properties, children: [] }));
        }
        break;
      case "h1":
      case "h2":
      case "h3":
      case "h4": {
        const headings = {
          h1: HeadingLevel.HEADING_1,
          h2: HeadingLevel.HEADING_2,
          h3: HeadingLevel.HEADING_3,
          h4: HeadingLevel.HEADING_4,
        } as const;
        blocks.push(
          paragraphFromHtml(node.childNodes, {
            ...properties,
            heading: headings[node.tagName],
          }),
        );
        break;
      }
      case "blockquote":
        blocks.push(
          paragraphFromHtml(node.childNodes, {
            ...properties,
            indent: { left: 720 },
          }),
        );
        break;
      case "pre":
        blocks.push(
          paragraphFromHtml(node.childNodes, properties, { font: "Consolas" }),
        );
        break;
      case "ul":
      case "ol":
        blocks.push(...htmlList(node, context, 0));
        break;
      case "table": {
        const table = htmlTable(node, context);
        if (table !== undefined) blocks.push(table);
        break;
      }
      case "hr":
        blocks.push(
          new Paragraph({
            ...properties,
            border: {
              bottom: { color: "auto", style: BorderStyle.SINGLE, size: 6 },
            },
          }),
        );
        break;
    }
  }
  flush();
  return blocks;
}

function containsHtmlMarkup(node: DefaultTreeAdapterTypes.ParentNode): boolean {
  return node.childNodes.some((child) => {
    if (!isHtmlElement(child)) return false;
    // parse5 会把 Markdown 自动链接 <https://…> 识别成 scheme 标签；它不是富文本。
    if (/^[a-z][a-z0-9+.-]*:$/iu.test(child.tagName)) return false;
    return true;
  });
}

function docxDocumentFromHtml(title: string, bodyText: string): Document {
  const source = parseFragment(bodyText);
  let children: Array<Paragraph | Table>;
  let numbering: NumberingDefinition[] = [];
  if (!containsHtmlMarkup(source)) {
    // 纯文本/Markdown 仍沿用旧行为：每个换行是一个段落，不解释 Markdown 语法。
    children = bodyText
      .split(/\r\n|\r|\n/u)
      .map((line) => new Paragraph({ children: [new TextRun(line)] }));
  } else {
    const fragment = parseFragment(sanitizeDocHtml(bodyText));
    const context: HtmlDocxContext = { numbering: [], nextList: 0 };
    children = htmlBlocks(fragment.childNodes, context);
    if (children.length === 0) children = [new Paragraph("")];
    numbering = context.numbering;
  }
  return new Document({
    creator: "OPC Hub",
    title,
    numbering: { config: numbering },
    sections: [{ children }],
  });
}

async function importDocx(buffer: Buffer): Promise<string> {
  try {
    const result = await mammoth.convertToHtml(
      { buffer },
      // mammoth 默认忽略下划线；显式映射后才能在上层 HTML 契约中保留。
      { styleMap: ["u => u"] },
    );
    const bodyText = sanitizeDocHtml(result.value);
    assertBodyText(bodyText);
    return bodyText;
  } catch (error) {
    if (error instanceof FormatError) throw error;
    throw new FormatError("invalid_docx", "DOCX 解析失败，文件可能已损坏。", {
      cause: error,
    });
  }
}

async function importPdf(buffer: Buffer): Promise<string> {
  const options: Parameters<typeof getPdfDocument>[0] & {
    readonly isEvalSupported: boolean;
  } = {
    data: Uint8Array.from(buffer),
    isEvalSupported: false,
  };
  const loadingTask = getPdfDocument(options);
  try {
    const pdf = await loadingTask.promise;
    if (pdf.numPages > MAX_PDF_PAGES) {
      throw new FormatError(
        "too_large",
        `PDF 超过 ${MAX_PDF_PAGES} 页，拒绝导入。`,
      );
    }
    const pages: string[] = [];
    let totalChars = 0;
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
      const page = await pdf.getPage(pageNumber);
      const content = await page.getTextContent();
      const parts: string[] = [];
      for (const item of content.items) {
        if ("str" in item && typeof item.str === "string") parts.push(item.str);
      }
      const text = parts.join("\n");
      totalChars += text.length + (pages.length > 0 ? 1 : 0);
      if (totalChars > MAX_DOC_BODY_CHARS) {
        throw new FormatError(
          "too_large",
          `PDF 提取正文超过 ${MAX_DOC_BODY_CHARS} 字符上限。`,
        );
      }
      pages.push(text);
    }
    const bodyText = pages.join("\f");
    assertBodyText(bodyText);
    return bodyText;
  } catch (error) {
    if (error instanceof FormatError) throw error;
    throw new FormatError("invalid_pdf", "PDF 解析失败，文件可能已损坏。", {
      cause: error,
    });
  } finally {
    await loadingTask.destroy().catch(() => undefined);
  }
}

export async function importDocumentBytes(input: {
  buffer: Buffer;
  format: DocumentFormat;
}): Promise<{ kind: DocKind; bodyText: string; mime: string }> {
  if (!isRecord(input) || !Buffer.isBuffer(input.buffer)) {
    throw new FormatError("invalid_buffer", "文档输入必须是含 Buffer 的对象。");
  }
  const format = input.format;
  if (!["docx", "xlsx", "pdf", "md"].includes(format)) {
    throw new FormatError(
      "unsupported_format",
      `不支持的导入格式：${String(format)}。`,
    );
  }
  const detected = detectDocumentFormat({ buffer: input.buffer });
  if (detected !== format) {
    throw new FormatError(
      "format_mismatch",
      `文档签名检测为 ${detected}，与声明格式 ${format} 不一致。`,
    );
  }
  let bodyText: string;
  if (format === "docx") bodyText = await importDocx(input.buffer);
  else if (format === "xlsx") bodyText = await importXlsx(input.buffer);
  else if (format === "pdf") bodyText = await importPdf(input.buffer);
  else bodyText = decodeMarkdown(input.buffer);
  assertBodyText(bodyText);
  const kind: DocKind =
    format === "xlsx" ? "sheet" : format === "md" ? "markdown" : "doc";
  return { kind, bodyText, mime: MIME_BY_FORMAT[format] };
}

function sanitizedFilename(title: string, format: DocExportFormat): string {
  if (typeof title !== "string") {
    throw new FormatError("invalid_title", "导出标题必须是字符串。");
  }
  const cleaned = title
    .normalize("NFKC")
    .replace(/[\p{Cc}\p{Cf}<>:"/\\|?*]/gu, "_")
    .replace(/\s+/gu, " ")
    .trim()
    .replace(/^[. ]+|[. ]+$/gu, "");
  let stem = Array.from(cleaned)
    .slice(0, 120)
    .join("")
    .replace(/[. ]+$/u, "");
  if (stem === "") stem = "document";
  if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(stem)) {
    stem = `_${stem}`;
  }
  return `${stem}.${format}`;
}

const EXCEL_BORDER_STYLES = new Set<string>([
  "thin",
  "dotted",
  "hair",
  "medium",
  "double",
  "thick",
  "dashed",
  "dashDot",
  "dashDotDot",
  "slantDashDot",
  "mediumDashed",
  "mediumDashDot",
  "mediumDashDotDot",
]);
const EXCEL_HORIZONTAL_ALIGNMENTS = new Set<string>([
  "left",
  "center",
  "right",
  "fill",
  "justify",
  "centerContinuous",
  "distributed",
]);
const EXCEL_VERTICAL_ALIGNMENTS = new Set<string>([
  "top",
  "middle",
  "bottom",
  "distributed",
  "justify",
]);

function invalidSheetStyle(message: string): never {
  throw new FormatError("invalid_sheet", message);
}

function sheetColor(value: unknown, field: string): string {
  if (
    typeof value !== "string" ||
    !/^[0-9a-f]{6}(?:[0-9a-f]{2})?$/iu.test(value)
  ) {
    return invalidSheetStyle(
      `XLSX styles.${field} 必须是 6/8 位十六进制颜色。`,
    );
  }
  const normalized = value.toUpperCase();
  return normalized.length === 6 ? `FF${normalized}` : normalized;
}

function sheetBorderSide(value: unknown): SheetBorderSide {
  if (typeof value === "string") {
    if (!EXCEL_BORDER_STYLES.has(value)) {
      return invalidSheetStyle("XLSX styles.border 样式无效。");
    }
    return { style: value as ExcelJS.BorderStyle };
  }
  if (!isRecord(value) || typeof value.style !== "string") {
    return invalidSheetStyle("XLSX styles.border 必须是边框对象。");
  }
  if (!EXCEL_BORDER_STYLES.has(value.style)) {
    return invalidSheetStyle("XLSX styles.border 样式无效。");
  }
  return {
    style: value.style as ExcelJS.BorderStyle,
    ...(value.color === undefined
      ? {}
      : { color: sheetColor(value.color, "border.color") }),
  };
}

function sheetBorder(value: unknown): SheetBorder {
  if (typeof value === "string") {
    const side = sheetBorderSide(value);
    return { top: side, left: side, bottom: side, right: side };
  }
  if (!isRecord(value)) {
    return invalidSheetStyle("XLSX styles.border 必须是边框对象。");
  }
  if (value.style !== undefined) {
    const side = sheetBorderSide(value);
    return { top: side, left: side, bottom: side, right: side };
  }
  const border: {
    top?: SheetBorderSide;
    left?: SheetBorderSide;
    bottom?: SheetBorderSide;
    right?: SheetBorderSide;
  } = {};
  for (const side of ["top", "left", "bottom", "right"] as const) {
    if (value[side] !== undefined) border[side] = sheetBorderSide(value[side]);
  }
  return border;
}

function sheetAlignment(value: unknown): SheetAlignment {
  if (!isRecord(value)) {
    return invalidSheetStyle("XLSX styles.align 必须是对象。");
  }
  const align: SheetAlignment = {};
  if (value.horizontal !== undefined) {
    if (
      typeof value.horizontal !== "string" ||
      !EXCEL_HORIZONTAL_ALIGNMENTS.has(value.horizontal)
    ) {
      return invalidSheetStyle("XLSX styles.align.horizontal 无效。");
    }
    align.horizontal = value.horizontal as ExcelJS.Alignment["horizontal"];
  }
  if (value.vertical !== undefined) {
    if (
      typeof value.vertical !== "string" ||
      !EXCEL_VERTICAL_ALIGNMENTS.has(value.vertical)
    ) {
      return invalidSheetStyle("XLSX styles.align.vertical 无效。");
    }
    align.vertical = value.vertical as ExcelJS.Alignment["vertical"];
  }
  for (const key of ["wrapText", "shrinkToFit"] as const) {
    if (value[key] !== undefined) {
      if (typeof value[key] !== "boolean") {
        return invalidSheetStyle(`XLSX styles.align.${key} 必须是布尔值。`);
      }
      align[key] = value[key];
    }
  }
  if (value.indent !== undefined) {
    if (
      typeof value.indent !== "number" ||
      !Number.isInteger(value.indent) ||
      value.indent < 0 ||
      value.indent > 250
    ) {
      return invalidSheetStyle("XLSX styles.align.indent 无效。");
    }
    align.indent = value.indent;
  }
  if (value.readingOrder !== undefined) {
    if (value.readingOrder !== "rtl" && value.readingOrder !== "ltr") {
      return invalidSheetStyle("XLSX styles.align.readingOrder 无效。");
    }
    align.readingOrder = value.readingOrder;
  }
  if (value.textRotation !== undefined) {
    if (
      value.textRotation !== "vertical" &&
      !(
        typeof value.textRotation === "number" &&
        Number.isInteger(value.textRotation) &&
        value.textRotation >= -90 &&
        value.textRotation <= 90
      )
    ) {
      return invalidSheetStyle("XLSX styles.align.textRotation 无效。");
    }
    align.textRotation = value.textRotation;
  }
  return align;
}

function sheetCellStyle(value: unknown): SheetCellStyle | null {
  if (value === null || value === undefined) return null;
  if (!isRecord(value)) {
    return invalidSheetStyle("XLSX styles 每格必须是样式对象或 null。");
  }
  type MutableStyle = {
    -readonly [Key in keyof SheetCellStyle]: SheetCellStyle[Key];
  };
  const style: MutableStyle = {};
  for (const key of ["bold", "italic"] as const) {
    if (value[key] !== undefined) {
      if (typeof value[key] !== "boolean") {
        return invalidSheetStyle(`XLSX styles.${key} 必须是布尔值。`);
      }
      style[key] = value[key];
    }
  }
  if (value.fill !== undefined) style.fill = sheetColor(value.fill, "fill");
  if (value.color !== undefined) style.color = sheetColor(value.color, "color");
  if (value.border !== undefined) style.border = sheetBorder(value.border);
  if (value.numFmt !== undefined) {
    if (
      typeof value.numFmt !== "string" ||
      value.numFmt.length > 64 ||
      value.numFmt.includes("\0")
    ) {
      return invalidSheetStyle("XLSX styles.numFmt 无效。");
    }
    style.numFmt = value.numFmt;
  }
  if (value.align !== undefined) style.align = sheetAlignment(value.align);
  return Object.keys(style).length === 0 ? null : style;
}

function sheetStyles(
  value: unknown,
  rows: readonly Primitive[][],
): Array<Array<SheetCellStyle | null>> | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > rows.length) {
    return invalidSheetStyle("XLSX styles 必须是不得超过 rows 的二维数组。");
  }
  return rows.map((row, rowIndex) => {
    const rawRow = value[rowIndex];
    if (rawRow !== undefined && !Array.isArray(rawRow)) {
      return invalidSheetStyle("XLSX styles 每行必须是数组。");
    }
    if (rawRow !== undefined && rawRow.length > row.length) {
      return invalidSheetStyle("XLSX styles 不能超过对应 rows 的列数。");
    }
    return row.map((_, columnIndex) => sheetCellStyle(rawRow?.[columnIndex]));
  });
}

function parseSheetPayload(bodyText: string): SheetPayload {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch (error) {
    throw new FormatError(
      "invalid_sheet",
      "XLSX 导出的正文必须是 {sheets:[{name,rows}]} JSON。",
      { cause: error },
    );
  }
  if (
    !isRecord(parsed) ||
    !Array.isArray(parsed.sheets) ||
    parsed.sheets.length === 0
  ) {
    throw new FormatError(
      "invalid_sheet",
      "XLSX 正文的 sheets 必须是非空数组。",
    );
  }
  const names = new Set<string>();
  const sheets: Array<{
    name: string;
    rows: Primitive[][];
    styles?: Array<Array<SheetCellStyle | null>>;
  }> = [];
  for (const rawSheet of parsed.sheets) {
    if (
      !isRecord(rawSheet) ||
      typeof rawSheet.name !== "string" ||
      rawSheet.name.trim() === "" ||
      rawSheet.name.length > 31 ||
      !Array.isArray(rawSheet.rows)
    ) {
      throw new FormatError(
        "invalid_sheet",
        "XLSX 的 sheet 名称或 rows 形状无效。",
      );
    }
    const normalizedName = rawSheet.name.toLowerCase();
    if (names.has(normalizedName)) {
      throw new FormatError(
        "invalid_sheet",
        `XLSX 工作表名称重复：${rawSheet.name}。`,
      );
    }
    names.add(normalizedName);
    if (rawSheet.rows.length > MAX_SHEET_ROWS) {
      throw new FormatError(
        "too_large",
        `XLSX 单表超过 ${MAX_SHEET_ROWS} 行。`,
      );
    }
    const rows: Primitive[][] = [];
    for (const rawRow of rawSheet.rows) {
      if (!Array.isArray(rawRow) || rawRow.length > MAX_SHEET_COLUMNS) {
        throw new FormatError(
          "invalid_sheet",
          "XLSX 的 rows 必须是合法二维原始值数组。",
        );
      }
      const row: Primitive[] = [];
      for (const cell of rawRow) {
        if (
          cell !== null &&
          typeof cell !== "string" &&
          typeof cell !== "boolean" &&
          !(typeof cell === "number" && Number.isFinite(cell))
        ) {
          throw new FormatError(
            "invalid_sheet",
            "XLSX 单元格只允许字符串、有限数值、布尔值或 null。",
          );
        }
        if (typeof cell === "string" && cell.includes("\0")) {
          throw new FormatError(
            "invalid_sheet",
            "XLSX 单元格不能含有 NUL 字符。",
          );
        }
        row.push(cell);
      }
      rows.push(row);
    }
    const styles = sheetStyles(rawSheet.styles, rows);
    sheets.push({
      name: rawSheet.name,
      rows,
      ...(styles === undefined ? {} : { styles }),
    });
  }
  return { sheets };
}

function excelBorder(
  border: SheetBorder | ExcelJS.BorderStyle,
): Partial<ExcelJS.Borders> {
  if (typeof border === "string") {
    const side = { style: border };
    return { top: side, left: side, bottom: side, right: side };
  }
  const result: Partial<ExcelJS.Borders> = {};
  for (const key of ["top", "left", "bottom", "right"] as const) {
    const side = border[key];
    if (side !== undefined) {
      result[key] = {
        style: side.style,
        ...(side.color === undefined ? {} : { color: { argb: side.color } }),
      };
    }
  }
  return result;
}

async function exportXlsx(title: string, bodyText: string): Promise<Buffer> {
  const payload = parseSheetPayload(bodyText);
  try {
    const workbook = new ExcelJS.Workbook();
    workbook.creator = "OPC Hub";
    workbook.title = title;
    for (const sheet of payload.sheets) {
      const worksheet = workbook.addWorksheet(sheet.name);
      const columnCount = sheet.rows.reduce(
        (maximum, row) => Math.max(maximum, row.length),
        0,
      );
      for (const [rowIndex, row] of sheet.rows.entries()) {
        const excelRow = worksheet.getRow(rowIndex + 1);
        for (let columnIndex = 0; columnIndex < columnCount; columnIndex += 1) {
          const value = row[columnIndex] ?? null;
          const cell = excelRow.getCell(columnIndex + 1);
          cell.value =
            typeof value === "string" &&
            value.startsWith("=") &&
            value.length > 1
              ? { formula: value.slice(1) }
              : value;
          const style = sheet.styles?.[rowIndex]?.[columnIndex] ?? null;
          cell.border =
            style?.border === undefined
              ? {
                  top: { style: "thin" },
                  left: { style: "thin" },
                  bottom: { style: "thin" },
                  right: { style: "thin" },
                }
              : excelBorder(style.border);
          const font: Partial<ExcelJS.Font> = {};
          if (rowIndex === 0) font.bold = true;
          else if (style?.bold !== undefined) font.bold = style.bold;
          if (style?.italic !== undefined) font.italic = style.italic;
          if (style?.color !== undefined) {
            font.color = { argb: style.color };
          }
          if (Object.keys(font).length > 0) cell.font = font;
          if (style?.fill !== undefined) {
            cell.fill = {
              type: "pattern",
              pattern: "solid",
              fgColor: { argb: style.fill },
            };
          }
          if (style?.numFmt !== undefined) cell.numFmt = style.numFmt;
          if (style?.align !== undefined) cell.alignment = style.align;
        }
      }
    }
    const written = await workbook.xlsx.writeBuffer();
    if (!Buffer.isBuffer(written)) {
      throw new FormatError("invalid_xlsx", "XLSX 生成器没有返回 Buffer。");
    }
    return written;
  } catch (error) {
    if (error instanceof FormatError) throw error;
    throw new FormatError("invalid_xlsx", "XLSX 生成失败。", { cause: error });
  }
}

async function exportDocx(title: string, bodyText: string): Promise<Buffer> {
  try {
    return await Packer.toBuffer(docxDocumentFromHtml(title, bodyText));
  } catch (error) {
    if (error instanceof FormatError) throw error;
    throw new FormatError("invalid_docx", "DOCX 生成失败。", { cause: error });
  }
}

function cjkFontCandidates(): string[] {
  const override = process.env["OPC_CJK_FONT_PATH"]?.trim();
  const candidates: string[] =
    override === undefined || override === "" ? [] : [override];
  if (process.platform === "win32") {
    const windows =
      process.env["WINDIR"] ?? process.env["SystemRoot"] ?? "C:/Windows";
    const fonts = `${windows}/Fonts`;
    candidates.push(
      `${fonts}/msyh.ttc`,
      `${fonts}/simhei.ttf`,
      `${fonts}/simsun.ttc`,
    );
  } else if (process.platform === "darwin") {
    candidates.push(
      "/System/Library/Fonts/PingFang.ttc",
      "/System/Library/Fonts/STHeiti Medium.ttc",
    );
  } else {
    candidates.push(
      "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
      "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.otf",
      "/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc",
      "/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc",
    );
  }
  return [...new Set(candidates)];
}

function missingCodePoints(font: PDFFont, text: string): number[] {
  const supported = new Set(font.getCharacterSet());
  const missing = new Set<number>();
  for (const character of text) {
    const codePoint = character.codePointAt(0);
    if (codePoint === undefined || codePoint === 0 || codePoint < 32) continue;
    if (!supported.has(codePoint)) missing.add(codePoint);
  }
  return [...missing];
}

async function embedCjkFont(
  pdf: PDFDocument,
  bodyText: string,
): Promise<PDFFont> {
  pdf.registerFontkit(fontkit);
  const failures: string[] = [];
  for (const path of cjkFontCandidates()) {
    let bytes: Buffer;
    try {
      bytes = await readFile(path);
    } catch (error) {
      const code = isRecord(error) ? error.code : undefined;
      if (code === "ENOENT" || code === "ENOTDIR") continue;
      failures.push(`${path}: ${reason(error)}`);
      continue;
    }
    try {
      const font = await pdf.embedFont(bytes, { subset: true });
      const missing = missingCodePoints(font, bodyText);
      if (missing.length > 0) {
        failures.push(
          `${path}: 缺字形 U+${missing.map((point) => point.toString(16).toUpperCase()).join(", U+")}`,
        );
        continue;
      }
      return font;
    } catch (error) {
      failures.push(`${path}: ${reason(error)}`);
    }
  }
  throw new FormatError(
    "font_unavailable",
    "PDF 导出找不到可覆盖全部字符的 CJK 字体，拒绝静默丢字。可设置 OPC_CJK_FONT_PATH。" +
      (failures.length > 0 ? ` 候选失败：${failures.join("；")}` : ""),
  );
}

function graphemes(text: string): string[] {
  return Array.from(
    new Intl.Segmenter("und", { granularity: "grapheme" }).segment(text),
    (part) => part.segment,
  );
}

function wrapPdfLine(
  line: string,
  font: PDFFont,
  size: number,
  width: number,
): string[] {
  if (line === "") return [""];
  const lines: string[] = [];
  let current = "";
  for (const character of graphemes(line)) {
    const candidate = current + character;
    if (current !== "" && font.widthOfTextAtSize(candidate, size) > width) {
      lines.push(current);
      current = character;
    } else {
      current = candidate;
    }
  }
  if (current !== "") lines.push(current);
  return lines;
}

function drawPdfLine(
  page: PDFPage,
  font: PDFFont,
  text: string,
  y: number,
): void {
  if (text !== "") {
    page.drawText(text, { x: 48, y, size: 12, font, lineHeight: 18 });
  }
}

async function exportPdf(title: string, bodyText: string): Promise<Buffer> {
  const pdf = await PDFDocument.create();
  pdf.setTitle(title);
  pdf.setCreator("OPC Hub");
  const font = await embedCjkFont(pdf, bodyText);
  const width = 595.28 - 96;
  const lineHeight = 18;
  const bottom = 48;
  const top = 793.89;
  let page = pdf.addPage([595.28, 841.89]);
  let y = top;
  // \f 是导入侧的页分隔符；导出保留它，多页纪要回导才不会粘成一页。
  const textPages = bodyText.split("\f");
  for (const [pageIndex, pageText] of textPages.entries()) {
    if (pageIndex > 0) {
      page = pdf.addPage([595.28, 841.89]);
      y = top;
    }
    for (const logicalLine of pageText.split(/\r\n|\r|\n/u)) {
      for (const line of wrapPdfLine(logicalLine, font, 12, width)) {
        if (y < bottom) {
          page = pdf.addPage([595.28, 841.89]);
          y = top;
        }
        drawPdfLine(page, font, line, y);
        y -= lineHeight;
      }
    }
  }
  return Buffer.from(await pdf.save());
}

export async function exportDocument(input: {
  kind: DocKind;
  title: string;
  bodyText: string;
  format: DocExportFormat;
}): Promise<{ buffer: Buffer; mime: string; filename: string }> {
  if (!isRecord(input) || typeof input.bodyText !== "string") {
    throw new FormatError("invalid_body", "导出请求必须含字符串 bodyText。");
  }
  assertBodyText(input.bodyText);
  const format = input.format;
  if (!["md", "docx", "xlsx", "pdf"].includes(format)) {
    throw new FormatError(
      "unsupported_format",
      `不支持的导出格式：${String(format)}。`,
    );
  }
  if (format === "xlsx" && input.kind !== "sheet") {
    throw new FormatError("kind_mismatch", "只有 sheet 形态可以导出为 XLSX。");
  }
  const filename = sanitizedFilename(input.title, format);
  let buffer: Buffer;
  if (format === "md") buffer = Buffer.from(input.bodyText, "utf8");
  else if (format === "docx")
    buffer = await exportDocx(input.title, input.bodyText);
  else if (format === "xlsx")
    buffer = await exportXlsx(input.title, input.bodyText);
  else buffer = await exportPdf(input.title, input.bodyText);
  assertBuffer(buffer);
  return { buffer, mime: MIME_BY_FORMAT[format], filename };
}
