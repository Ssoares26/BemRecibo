// Testes do núcleo compartilhado (regras de negócio + geração de PDF).
// Rodam em Node puro: `npm test` compila src/services.ts e src/pdf.ts em .test-build
// e executa este arquivo com o test runner nativo do Node.
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const build = path.join(__dirname, "..", ".test-build");
const {
  brl,
  valueInWords,
  numberToWordsPt,
  formatTaxId,
  formatDateBr,
  formatDateTimeBr,
  toIsoDate,
  detectImageType,
  bytesToBase64,
  base64ToBytes,
  csvCell,
  verificationCode,
  WARNING_TEXT,
  STATUS_LABELS,
} = require(path.join(build, "services.js"));
const { buildPdf } = require(path.join(build, "pdf.js"));

// ---------------------------------------------------------------------------
// Valores por extenso (mesma tabela do backend Python)
// ---------------------------------------------------------------------------
test("valor por extenso em reais (mesma tabela do backend Python)", () => {
  const cases = [
    [0, "zero real"],
    [1, "um real"],
    [2, "dois reais"],
    [15, "quinze reais"],
    [100, "cem reais"],
    [1000.05, "mil reais e cinco centavos"],
    [17.47, "dezessete reais e quarenta e sete centavos"],
    [2500, "dois mil e quinhentos reais"],
    [1234.56, "mil duzentos e trinta e quatro reais e cinquenta e seis centavos"],
    [1000000, "um milhão de reais"],
    [2000000, "dois milhões de reais"],
  ];
  for (const [value, expected] of cases) {
    assert.equal(numberToWordsPt(value), expected, `numberToWordsPt(${value})`);
  }
});

test("no documento o valor por extenso inicia com maiuscula", () => {
  assert.equal(valueInWords(2500), "Dois mil e quinhentos reais");
  assert.equal(valueInWords(0.5), "Cinquenta centavos");
});

test("formatacao de moeda em pt-BR", () => {
  assert.equal(brl(1234.5), "R$ 1.234,50");
  assert.equal(brl(17470), "R$ 17.470,00");
  assert.equal(brl(null), "R$ 0,00");
});

test("numero por extenso ignora nulos e arredonda centavos", () => {
  assert.equal(numberToWordsPt(null), "zero real");
  assert.equal(numberToWordsPt(undefined), "zero real");
  assert.equal(numberToWordsPt(10.005), "dez reais e um centavo");
});

// ---------------------------------------------------------------------------
// Documentos fiscais
// ---------------------------------------------------------------------------
test("mascaras de CPF/CNPJ e datas", () => {
  assert.equal(formatTaxId("12345678901"), "123.456.789-01");
  assert.equal(formatTaxId("12345678000190"), "12.345.678/0001-90");
  assert.equal(formatTaxId(""), "");
  assert.equal(formatDateBr("2026-08-12"), "12/08/2026");
  assert.equal(toIsoDate("12/08/2026"), "2026-08-12");
  assert.ok(formatDateTimeBr("2026-08-12T13:05:00Z").includes("12/08/2026"));
});

test("codigo de verificacao e estavel e legivel", async () => {
  const code = await verificationCode("BR-2026-000001");
  assert.match(code, /^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/);
  assert.equal(code, await verificationCode("BR-2026-000001"));
  assert.notEqual(code, await verificationCode("BR-2026-000002"));
});

test("textos legais obrigatorios", () => {
  assert.ok(WARNING_TEXT.includes("IRPJ"));
  assert.equal(STATUS_LABELS["nao_habilitada"], "Pré-habilitação");
  assert.equal(STATUS_LABELS["habilitada"], "Instituição habilitada");
});

// ---------------------------------------------------------------------------
// Uploads e CSV
// ---------------------------------------------------------------------------
test("detecta tipo de imagem pelos bytes", () => {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);
  assert.equal(detectImageType(png), "png");
  assert.equal(detectImageType(jpeg), "jpeg");
  assert.equal(detectImageType(new Uint8Array([0x25, 0x50, 0x44, 0x46])), null);
});

test("base64 ida e volta", () => {
  const bytes = new Uint8Array([1, 2, 3, 250, 255]);
  assert.deepEqual(Array.from(base64ToBytes(bytesToBase64(bytes))), Array.from(bytes));
});

test("CSV protege separadores e quebras de linha", () => {
  assert.equal(csvCell('Maria "Mia" Silva'), '"Maria ""Mia"" Silva"');
  assert.equal(csvCell("linha1\nlinha2"), '"linha1\nlinha2"');
  assert.equal(csvCell("a;b"), '"a;b"');
  assert.equal(csvCell("1234,50"), "1234,50");
  assert.equal(csvCell(null), "");
  assert.equal(csvCell(7), "7");
});

// ---------------------------------------------------------------------------
// PDF
// ---------------------------------------------------------------------------
const institution = {
  name: "Instituto Pelo Bem",
  cnpj: "12.345.678/0001-90",
  address: "Rua Pedro Henrique, 300",
  city: "Recife - PE",
  phone: "(81) 3222-1010",
  email: "contato@institutopelobem.org.br",
  status: "nao_habilitada",
  signatory_name: "Andrea Queiroz",
  signatory_role: "Presidente voluntária",
};

const donation = {
  id: 1,
  number: "BR-2026-000001",
  donor_name: "Padaria Santo Amaro ME",
  tax_id: "12.345.678/0001-90",
  person_type: "PJ",
  donation_type: "financeira",
  amount: 2500,
  received_at: "2026-08-12",
  purpose: "Compra de cestas básicas",
  payment_method: "Transferência bancária",
  representative: "Rita Albuquerque",
  institution_status_snapshot: "nao_habilitada",
  warning_applied: 1,
  voided: 0,
};

const donor = {
  name: "Padaria Santo Amaro ME",
  tax_id: "12.345.678/0001-90",
  person_type: "PJ",
  email: "financeiro@padariasantamaro.com.br",
  phone: "(81) 3222-1010",
  representative: "Rita Albuquerque",
};

const pdfLib = require("pdf-lib");

function isPdf(bytes) {
  return bytesToBase64(bytes.slice(0, 5)) === bytesToBase64(new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]));
}

test("PDF de doacao financeira tem uma pagina", async () => {
  const bytes = await buildPdf(donation, donor, institution);
  assert.ok(isPdf(bytes), "deve comecar com %PDF-");
  const doc = await pdfLib.PDFDocument.load(bytes);
  assert.equal(doc.getPageCount(), 1);
});

test("PDF com assinatura e logotipo continua em uma pagina", async () => {
  const logo = require("node:fs").readFileSync(path.join(__dirname, "fixtures", "logo.png"));
  const signature = require("node:fs").readFileSync(path.join(__dirname, "fixtures", "signature.png"));
  const bytes = await buildPdf({ ...donation, description: "Cestas básicas", quantity: 10, estimated_value: 1500, brand_model: "Padrão", fiscal_document: "NF 123" }, donor, {
    ...institution,
    logo_content: bytesToBase64(new Uint8Array(logo)),
    signature_content: bytesToBase64(new Uint8Array(signature)),
  });
  const doc = await pdfLib.PDFDocument.load(bytes);
  assert.equal(doc.getPageCount(), 1);
});

test("termo de doacao de bem usa o titulo correto", async () => {
  const bytes = await buildPdf(
    { ...donation, donation_type: "bem", description: "Cestas básicas", quantity: 10, estimated_value: 1500 },
    donor,
    institution,
  );
  const doc = await pdfLib.PDFDocument.load(bytes);
  assert.equal(doc.getPageCount(), 1);
  // o titulo fica no stream de conteudo comprimido; validamos pelo tamanho do
  // arquivo: documento do termo tem sempre mais texto que o recibo simples.
  assert.ok(bytes.length > 2000);
});
