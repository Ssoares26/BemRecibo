/**
 * Geração dos documentos em PDF no runtime do Cloudflare Workers.
 *
 * O ReportLab (Python) não roda no Workers, então o mesmo layout foi
 * reimplementado com pdf-lib: cabeçalho institucional com logo, tabela de
 * dados, advertência fiscal, bloco de autenticidade, assinaturas e rodapé.
 */
import { PDFDocument, PDFFont, PDFImage, PDFPage, StandardFonts, rgb, RGB } from "pdf-lib";

import {
  STATUS_LABELS,
  VOID_NOTICE,
  WARNING_TEXT,
  base64ToBytes,
  brl,
  detectImageType,
  formatDateBr,
  formatTaxId,
  valueInWords,
  verificationCode,
} from "./services";
import type { DonationRow, InstitutionRow } from "./types";

const mm = (value: number) => (value * 72) / 25.4;

const PAGE_W = mm(210);
const PAGE_H = mm(297);
const MARGIN_X = mm(20);
const MARGIN_TOP = mm(14);
const MARGIN_BOTTOM = mm(22);
const CONTENT_W = PAGE_W - MARGIN_X * 2;
const BOTTOM_LIMIT = MARGIN_BOTTOM;

const GREEN = rgb(23 / 255, 60 / 255, 37 / 255);
const GREEN_SOFT = rgb(238 / 255, 244 / 255, 238 / 255);
const LINE = rgb(215 / 255, 224 / 255, 215 / 255);
const MUTED = rgb(104 / 255, 117 / 255, 108 / 255);
const INK = rgb(61 / 255, 74 / 255, 65 / 255);
const ORANGE = rgb(138 / 255, 75 / 255, 22 / 255);
const WARN_FILL = rgb(255 / 255, 248 / 255, 237 / 255);
const WARN_BORDER = rgb(233 / 255, 194 / 255, 139 / 255);
const AUTH_FILL = rgb(247 / 255, 249 / 255, 247 / 255);
const ZEBRA = rgb(251 / 255, 252 / 255, 251 / 255);
const FOOTER_INK = rgb(120 / 255, 132 / 255, 123 / 255);
const DANGER = rgb(163 / 255, 58 / 255, 42 / 255);

export type Runs = Array<{ text: string; bold?: boolean }>;

/**
 * WinAnsi (codificação das fontes padrão do PDF) não aceita todos os
 * caracteres. Normaliza tipografia e descarta o que não pode ser desenhado,
 * evitando erro na geração quando o cadastro traz emoji ou símbolos.
 */
const CHAR_MAP: Record<string, string> = {
  "\u2018": "'", "\u2019": "'", "\u201A": "'", "\u201B": "'",
  "\u201C": '"', "\u201D": '"', "\u201E": '"',
  "\u2212": "-", "\u2010": "-", "\u2011": "-",
  "\u2022": "-", "\u00B7": "\u00B7", "\u2026": "...",
  "\u00A0": " ", "\u2007": " ", "\u2009": " ", "\u202F": " ",
  "\u2192": "-", "\u2190": "-", "\u21D2": "-", "\u2264": "<=", "\u2265": ">=",
  "\u20AC": "EUR", "\u2122": "(TM)", "\u00AE": "(R)", "\u00A9": "(C)",
};

const ALLOWED_EXTRA = new Set(
  [0x2013, 0x2014, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2026, 0x20ac, 0x0152, 0x0153,
   0x0160, 0x0161, 0x0178, 0x017d, 0x017e, 0x0192, 0x02c6, 0x02dc, 0x2039, 0x203a, 0x2020,
   0x2021, 0x2113, 0x2122],
);

function sanitize(input: string | null | undefined): string {
  if (!input) return "";
  let output = "";
  for (const char of String(input)) {
    if (char === "\n" || char === "\r" || char === "\t") {
      output += " ";
      continue;
    }
    const mapped = CHAR_MAP[char];
    if (mapped !== undefined) {
      output += mapped;
      continue;
    }
    const code = char.codePointAt(0) ?? 0;
    const allowed =
      (code >= 0x20 && code <= 0x7e) ||
      (code >= 0xa0 && code <= 0xff) ||
      ALLOWED_EXTRA.has(code);
    if (allowed) output += char;
    else output += ""; // emoji e símbolos não suportados são omitidos
  }
  return output.replace(/\s+/g, " ");
}

const R = (text: string): Runs => [{ text }];
const B = (text: string): Runs => [{ text, bold: true }];
const mix = (...parts: Array<string | { bold: string }>): Runs =>
  parts.map((part) => (typeof part === "string" ? { text: part } : { text: part.bold, bold: true }));

interface ParagraphOptions {
  size?: number;
  leading?: number;
  color?: RGB;
  align?: "left" | "center" | "right";
  x?: number;
  width?: number;
  spaceBefore?: number;
  spaceAfter?: number;
}

class Doc {
  readonly pdf: PDFDocument;
  readonly regular: PDFFont;
  readonly boldFont: PDFFont;
  page!: PDFPage;
  pages: PDFPage[] = [];
  y = 0;

  constructor(pdf: PDFDocument, regular: PDFFont, boldFont: PDFFont) {
    this.pdf = pdf;
    this.regular = regular;
    this.boldFont = boldFont;
    this.newPage();
  }

  newPage(): void {
    this.page = this.pdf.addPage([PAGE_W, PAGE_H]);
    this.pages.push(this.page);
    this.y = PAGE_H - MARGIN_TOP;
  }

  ensure(space: number): void {
    if (this.y - space < BOTTOM_LIMIT) this.newPage();
  }

  private font(run: { bold?: boolean }): PDFFont {
    return run.bold ? this.boldFont : this.regular;
  }

  private widthOf(run: { text: string; bold?: boolean }, size: number): number {
    return this.font(run).widthOfTextAtSize(run.text, size);
  }

  lineWidth(line: Runs, size: number): number {
    return line.reduce((total, run) => total + this.widthOf(run, size), 0);
  }

  private tokenize(runs: Runs): Runs {
    const tokens: Runs = [];
    for (const run of runs) {
      const text = sanitize(run.text);
      if (!text) continue;
      for (const piece of text.split(/(\s+)/)) {
        if (piece) tokens.push({ text: piece, bold: run.bold });
      }
    }
    return tokens;
  }

  wrap(runs: Runs, maxWidth: number, size: number): Runs[] {
    const tokens = this.tokenize(runs);
    const lines: Runs[] = [];
    let current: Runs = [];
    let currentWidth = 0;

    // Remove espaços ao final da linha (inclusive os já agregados a um run),
    // para que a última palavra fique alinhada corretamente.
    const trimTrailing = () => {
      while (current.length) {
        const last = current[current.length - 1];
        const trimmed = last.text.replace(/\s+$/, "");
        if (trimmed === last.text) return;
        currentWidth -= this.widthOf(last, size);
        if (!trimmed) {
          current.pop();
          continue;
        }
        last.text = trimmed;
        currentWidth += this.widthOf(last, size);
        return;
      }
    };

    const pushLine = () => {
      trimTrailing();
      if (current.length) lines.push(current);
      current = [];
      currentWidth = 0;
    };

    for (const token of tokens) {
      const isSpace = /^\s+$/.test(token.text);
      if (isSpace) {
        // O espaço entra no próprio run anterior: assim o PDF desenha a
        // palavra e o espaço na mesma sequência de texto (kerning correto e
        // texto copiável).
        if (!current.length) continue;
        const last = current[current.length - 1];
        if (/\s$/.test(last.text)) continue;
        last.text += " ";
        currentWidth += this.widthOf({ text: " ", bold: last.bold }, size);
        continue;
      }

      const width = this.widthOf(token, size);
      if (width > maxWidth) {
        for (const char of token.text) {
          const piece = { text: char, bold: token.bold };
          const pieceWidth = this.widthOf(piece, size);
          if (currentWidth + pieceWidth > maxWidth && current.length) pushLine();
          current.push(piece);
          currentWidth += pieceWidth;
        }
        continue;
      }

      if (currentWidth + width > maxWidth && current.length) pushLine();
      current.push(token);
      currentWidth += width;
    }

    pushLine();
    return lines.length ? lines : [[]];
  }

  drawLine(line: Runs, x: number, baseline: number, size: number, color: RGB, align: ParagraphOptions["align"] = "left", width = CONTENT_W): void {
    const safe: Runs = line
      .map((run) => ({ text: sanitize(run.text), bold: run.bold }))
      .filter((run) => run.text.length > 0);
    if (!safe.length) return;
    line = safe;
    const total = this.lineWidth(line, size);
    let cursor = x;
    if (align === "center") cursor = x + (width - total) / 2;
    else if (align === "right") cursor = x + width - total;

    for (const run of line) {
      if (run.text) {
        this.page.drawText(run.text, {
          x: cursor,
          y: baseline,
          size,
          font: this.font(run),
          color,
        });
      }
      cursor += this.widthOf(run, size);
    }
  }

  paragraph(runs: Runs, options: ParagraphOptions = {}): void {
    const size = options.size ?? 9;
    const leading = options.leading ?? size * 1.5;
    const color = options.color ?? INK;
    const align = options.align ?? "left";
    const x = options.x ?? MARGIN_X;
    const width = options.width ?? CONTENT_W;

    this.y -= options.spaceBefore ?? 0;
    const lines = this.wrap(runs, width, size);
    for (const line of lines) {
      this.ensure(leading);
      this.y -= leading;
      this.drawLine(line, x, this.y, size, color, align, width);
    }
    this.y -= options.spaceAfter ?? 0;
  }

  rule(color: RGB = LINE, thickness = 0.6, spaceBefore = 0, spaceAfter = 0): void {
    this.y -= spaceBefore;
    this.ensure(thickness + 1);
    this.page.drawLine({
      start: { x: MARGIN_X, y: this.y },
      end: { x: PAGE_W - MARGIN_X, y: this.y },
      thickness,
      color,
    });
    this.y -= thickness + spaceAfter;
  }

  rect(x: number, y: number, width: number, height: number, fill?: RGB, border?: RGB, thickness = 0.5): void {
    this.page.drawRectangle({
      x,
      y,
      width,
      height,
      color: fill,
      borderColor: border,
      borderWidth: border ? thickness : undefined,
    });
  }

  async imageBox(contentB64: string | null | undefined, maxW: number, maxH: number): Promise<{ image: PDFImage; width: number; height: number } | null> {
    if (!contentB64) return null;
    try {
      const bytes = base64ToBytes(contentB64);
      const type = detectImageType(bytes);
      if (!type) return null;
      const image = type === "png" ? await this.pdf.embedPng(bytes) : await this.pdf.embedJpg(bytes);
      const scale = Math.min(maxW / image.width, maxH / image.height);
      return { image, width: image.width * scale, height: image.height * scale };
    } catch {
      return null;
    }
  }

  /** Bloco com fundo e borda contendo um rótulo e um texto (autenticidade). */
  boxedRow(
    label: Runs,
    value: Runs,
    options: {
      labelWidth?: number;
      fill?: RGB;
      border?: RGB;
      size?: number;
      leading?: number;
      padding?: number;
      color?: RGB;
      labelColor?: RGB;
    } = {},
  ): void {
    const labelWidth = options.labelWidth ?? mm(30);
    const size = options.size ?? 8.7;
    const leading = options.leading ?? 11.4;
    const padding = options.padding ?? 5;
    const width = CONTENT_W;

    const labelLines = this.wrap(label, labelWidth - padding * 2, size);
    const valueLines = this.wrap(value, width - labelWidth - padding * 2, size);
    const rows = Math.max(labelLines.length, valueLines.length);
    const height = rows * leading + padding * 2;

    this.ensure(height + 4);
    const top = this.y;
    this.rect(MARGIN_X, top - height, width, height, options.fill ?? AUTH_FILL, options.border ?? LINE);

    const firstBaseline = top - padding - size * 0.82;
    labelLines.forEach((line, index) =>
      this.drawLine(line, MARGIN_X + padding, firstBaseline - index * leading, size, options.labelColor ?? GREEN, "left", labelWidth));
    valueLines.forEach((line, index) =>
      this.drawLine(line, MARGIN_X + labelWidth + padding, firstBaseline - index * leading, size, options.color ?? INK, "left", width - labelWidth - padding * 2));

    this.y = top - height;
  }

  /** Caixa de texto com quebra automática (advertência fiscal). */
  boxedText(runs: Runs, options: { size?: number; leading?: number; padding?: number; fill?: RGB; border?: RGB; color?: RGB } = {}): void {
    const size = options.size ?? 8.2;
    const leading = options.leading ?? 11.8;
    const padding = options.padding ?? 6;
    const lines = this.wrap(runs, CONTENT_W - padding * 2, size);
    const height = lines.length * leading + padding * 2;

    this.ensure(height + 4);
    const top = this.y;
    this.rect(MARGIN_X, top - height, CONTENT_W, height, options.fill ?? WARN_FILL, options.border ?? WARN_BORDER, 0.7);
    const firstBaseline = top - padding - size * 0.82;
    lines.forEach((line, index) =>
      this.drawLine(line, MARGIN_X + padding, firstBaseline - index * leading, size, options.color ?? ORANGE));
    this.y = top - height;
  }

  /** Tabela de rótulo/valor com fundo suave na coluna de rótulos. */
  table(rows: Array<{ label: Runs; value: Runs; bold?: boolean }>, options: { labelWidth?: number; size?: number; leading?: number; padding?: number } = {}): void {
    const labelWidth = options.labelWidth ?? mm(48);
    const size = options.size ?? 8.7;
    const leading = options.leading ?? 11.4;
    const padding = options.padding ?? 3.5;
    const valueWidth = CONTENT_W - labelWidth;

    rows.forEach((row, index) => {
      const labelLines = this.wrap(row.label, labelWidth - padding * 2, size);
      const valueLines = this.wrap(row.value, valueWidth - padding * 2, size);
      const lines = Math.max(labelLines.length, valueLines.length);
      const height = lines * leading + padding * 2;

      this.ensure(height);
      const top = this.y;

      this.rect(MARGIN_X, top - height, labelWidth, height, GREEN_SOFT, LINE, 0.4);
      this.rect(MARGIN_X + labelWidth, top - height, valueWidth, height, index % 2 ? ZEBRA : undefined, LINE, 0.4);

      const firstBaseline = top - padding - size * 0.82;
      labelLines.forEach((line, lineIndex) =>
        this.drawLine(line, MARGIN_X + padding, firstBaseline - lineIndex * leading, size, GREEN, "left", labelWidth - padding * 2));
      valueLines.forEach((line, lineIndex) =>
        this.drawLine(line, MARGIN_X + labelWidth + padding, firstBaseline - lineIndex * leading, size, INK, "left", valueWidth - padding * 2));

      this.y = top - height;
    });
  }
}

export interface PdfDonation {
  number: string;
  id: number;
  document_type: string;
  donation_type: "financeira" | "bem";
  received_at: string;
  purpose: string;
  payment_method: string | null;
  amount: number | null;
  description: string | null;
  quantity: number | null;
  estimated_value: number | null;
  brand_model: string | null;
  fiscal_document: string | null;
  notes: string | null;
  warning_applied: number | boolean;
  voided: number | boolean;
  institution_status_snapshot: string;
  created_at: string | null;
}

export interface PdfDonor {
  name: string;
  person_type: "PF" | "PJ";
  tax_id: string;
  representative: string | null;
  email: string | null;
  phone: string | null;
}

export async function buildPdf(
  donation: PdfDonation | DonationRow,
  donor: PdfDonor,
  institution: InstitutionRow | string,
): Promise<Uint8Array> {
  const inst: Partial<InstitutionRow> = typeof institution === "string" ? { name: institution } : institution;
  const institutionName = inst.name || "Instituto Pelo Bem";

  const pdf = await PDFDocument.create();
  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const boldFont = await pdf.embedFont(StandardFonts.HelveticaBold);
  pdf.setTitle(`${donation.document_type} ${donation.number}`);
  pdf.setAuthor(institutionName);
  pdf.setSubject("Recibo de doação");
  pdf.setProducer("BemRecibo · Cloudflare Workers");

  const doc = new Doc(pdf, regular, boldFont);

  // ------------------------------------------------------------- cabeçalho --
  const logo = await doc.imageBox(inst.logo_content, mm(30), mm(15));
  const identityLines = [
    inst.cnpj ? formatTaxId(inst.cnpj) : "",
    inst.address || "",
    inst.city || "",
    [inst.phone, inst.email, inst.site].filter(Boolean).join(" · "),
  ].filter(Boolean);

  const headerTop = doc.y;
  const textX = logo ? MARGIN_X + logo.width + mm(6) : MARGIN_X;
  const nameBaseline = headerTop - 12;
  doc.drawLine(B(institutionName), textX, nameBaseline, 13.5, GREEN, "left", CONTENT_W - (textX - MARGIN_X));

  let identityBottom = nameBaseline - 11;
  identityLines.forEach((line, index) => {
    const baseline = nameBaseline - 12 - index * 11;
    doc.drawLine(R(line), textX, baseline, 8, MUTED, "left", CONTENT_W - (textX - MARGIN_X));
    identityBottom = baseline;
  });

  if (logo) {
    doc.page.drawImage(logo.image, {
      x: MARGIN_X,
      y: headerTop - logo.height,
      width: logo.width,
      height: logo.height,
    });
  }

  const headerBottom = Math.min(identityBottom, logo ? headerTop - logo.height : identityBottom);
  doc.y = headerBottom - 2;
  doc.rule(GREEN, 1.4, 0, 8);

  doc.paragraph(B(sanitize(donation.document_type).toUpperCase()), {
    size: 12.5,
    leading: 16,
    color: GREEN,
    align: "center",
    spaceBefore: 2,
  });
  doc.paragraph(R(`Nº ${donation.number}`), {
    size: 10,
    leading: 13,
    color: MUTED,
    align: "center",
    spaceAfter: 4,
  });

  if (donation.voided) {
    doc.boxedText(R(VOID_NOTICE), {
      fill: rgb(253 / 255, 241 / 255, 239 / 255),
      border: rgb(227 / 255, 179 / 255, 170 / 255),
      color: DANGER,
      size: 8.2,
    });
    doc.y -= 8;
  }

  // ----------------------------------------------------------------- corpo --
  const donorType = donor.person_type === "PF" ? "Pessoa Física" : "Pessoa Jurídica";
  doc.paragraph(
    mix(
      "A instituição ",
      { bold: institutionName },
      " declara, para os devidos fins, que recebeu a doação abaixo descrita de ",
      { bold: donor.name },
      ", inscrito(a) no CPF/CNPJ sob o nº ",
      { bold: formatTaxId(donor.tax_id) },
      ", na data de ",
      { bold: formatDateBr(donation.received_at) },
      ".",
    ),
    { size: 9.2, leading: 14, color: INK, spaceAfter: 8 },
  );

  const rows: Array<{ label: Runs; value: Runs; bold?: boolean }> = [
    { label: R("Doador"), value: R(donor.name) },
    { label: R("Tipo de doador"), value: R(donorType) },
    { label: R("CPF/CNPJ"), value: R(formatTaxId(donor.tax_id)) },
  ];
  if (donor.representative) rows.push({ label: R("Representante legal"), value: R(donor.representative) });
  if (donor.email || donor.phone) {
    rows.push({ label: R("Contato"), value: R([donor.email, donor.phone].filter(Boolean).join(" · ")) });
  }

  rows.push(
    { label: R("Data de recebimento"), value: R(formatDateBr(donation.received_at)) },
    { label: R("Finalidade da doação"), value: R(donation.purpose) },
    { label: R("Forma de recebimento"), value: R(donation.payment_method || "Não informada") },
  );

  if (donation.donation_type === "financeira") {
    rows.push(
      { label: R("Modalidade"), value: R("Doação financeira") },
      { label: R("Valor da doação"), value: B(brl(donation.amount)), bold: true },
      { label: R("Valor por extenso"), value: R(valueInWords(donation.amount)) },
    );
  } else {
    rows.push(
      { label: R("Modalidade"), value: R("Doação de bem ou serviço") },
      { label: R("Descrição do bem/serviço"), value: R(donation.description || "") },
      { label: R("Quantidade"), value: R(donation.quantity ? String(donation.quantity) : "") },
      { label: R("Marca / modelo"), value: R(donation.brand_model || "Não informado") },
      { label: R("Documento fiscal"), value: R(donation.fiscal_document || "Não informado") },
      { label: R("Valor de mercado estimado"), value: B(brl(donation.estimated_value)), bold: true },
      { label: R("Valor por extenso"), value: R(valueInWords(donation.estimated_value)) },
    );
  }

  if (donation.notes) rows.push({ label: R("Observações"), value: R(donation.notes) });

  doc.table(rows);
  doc.y -= 8;

  if (donation.donation_type === "bem") {
    doc.paragraph(B("Termo de doação e entrega"), { size: 9.5, leading: 13, color: GREEN, spaceAfter: 2 });
    doc.paragraph(
      R(
        "O doador transfere à instituição, de forma gratuita e definitiva, a propriedade dos bens e " +
          "serviços identificados neste termo, que declara recebê-los em bom estado de conservação e " +
          "destiná-los exclusivamente às suas atividades assistenciais.",
      ),
      { size: 9.2, leading: 14, color: INK, spaceAfter: 6 },
    );
  }

  if (donation.warning_applied) {
    doc.boxedText(R(WARNING_TEXT));
    doc.y -= 6;
  }

  // --------------------------------------------------------- autenticidade --
  const code = await verificationCode(
    `${donation.number}|${donation.id}|${donation.received_at}|${donation.created_at ?? ""}`,
  );
  const stamp = new Date().toISOString().slice(0, 10).split("-").reverse().join("/");
  doc.boxedRow(
    B("Autenticidade"),
    mix(
      "Código de verificação ",
      { bold: code },
      ` · Registro ${donation.number} · emitido em ${stamp} pelo sistema BemRecibo. `,
      "Confira o código com a instituição antes de aceitar este documento.",
    ),
  );
  doc.y -= 4;

  // ------------------------------------------------------------ assinaturas --
  const signature = await doc.imageBox(inst.signature_content, mm(42), mm(16));
  const columnWidth = CONTENT_W / 2;
  const signatureHeight = signature ? signature.height : 0;

  doc.ensure(signatureHeight + 82); // mantém assinaturas + nota final na mesma página
  doc.y -= 10 + signatureHeight;

  if (signature) {
    doc.page.drawImage(signature.image, {
      x: MARGIN_X + (columnWidth - signature.width) / 2,
      y: doc.y,
      width: signature.width,
      height: signature.height,
    });
  }

  const lineY = doc.y - 2;
  [0, 1].forEach((column) => {
    const start = MARGIN_X + column * columnWidth + mm(4);
    doc.page.drawLine({
      start: { x: start, y: lineY },
      end: { x: start + columnWidth - mm(8), y: lineY },
      thickness: 0.7,
      color: MUTED,
    });
  });

  const captionY = lineY - 12;
  doc.drawLine(R("Responsável pela instituição"), MARGIN_X, captionY, 8.7, INK, "center", columnWidth);
  let extraY = captionY;
  if (inst.signatory_name) {
    extraY -= 11;
    doc.drawLine(B(inst.signatory_name), MARGIN_X, extraY, 8.7, INK, "center", columnWidth);
  }
  if (inst.signatory_role) {
    extraY -= 11;
    doc.drawLine(R(inst.signatory_role), MARGIN_X, extraY, 8.7, INK, "center", columnWidth);
  }
  doc.drawLine(R("Doador / representante"), MARGIN_X + columnWidth, captionY, 8.7, INK, "center", columnWidth);

  doc.y = extraY - 14;

  // ---------------------------------------------------------------- rodapé --
  const statusLabel = STATUS_LABELS[donation.institution_status_snapshot] ?? "Pré-habilitação";
  doc.paragraph(
    R(
      `Documento gerado pelo BemRecibo · Registro interno ${donation.number} · Status institucional ` +
        `no momento da emissão: ${statusLabel}. Modelo demonstrativo sujeito à validação ` +
        "institucional, contábil e jurídica.",
    ),
    { size: 7.4, leading: 10, color: FOOTER_INK },
  );

  const total = doc.pages.length;
  const issuedAt = new Date().toISOString();
  const issuedLabel = `${issuedAt.slice(8, 10)}/${issuedAt.slice(5, 7)}/${issuedAt.slice(0, 4)} ${issuedAt.slice(11, 16)} UTC`;

  doc.pages.forEach((page, index) => {
    const footerY = MARGIN_BOTTOM - 4;
    page.drawLine({
      start: { x: mm(22), y: footerY },
      end: { x: PAGE_W - mm(22), y: footerY },
      thickness: 0.6,
      color: LINE,
    });
    page.drawText(sanitize(`BemRecibo · Documento ${donation.number} · via do sistema`), {
      x: mm(22),
      y: footerY - 5,
      size: 7.5,
      font: regular,
      color: MUTED,
    });
    if (donation.voided) {
      page.drawText("DOCUMENTO CANCELADO", { x: mm(22), y: footerY - 14, size: 7.5, font: boldFont, color: DANGER });
    }
    const issuedText = sanitize(`Emitido em ${issuedLabel}`);
    page.drawText(issuedText, {
      x: PAGE_W - mm(22) - regular.widthOfTextAtSize(issuedText, 7.5),
      y: footerY - 5,
      size: 7.5,
      font: regular,
      color: MUTED,
    });
    const pageText = `Página ${index + 1} de ${total}`;
    page.drawText(pageText, {
      x: PAGE_W - mm(22) - regular.widthOfTextAtSize(pageText, 7.5),
      y: footerY - 14,
      size: 7.5,
      font: regular,
      color: MUTED,
    });
  });

  return pdf.save();
}
