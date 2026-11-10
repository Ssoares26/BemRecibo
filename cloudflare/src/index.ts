/**
 * BemRecibo — API completa no Cloudflare Workers (D1 + assets estáticos).
 *
 * Mantém o mesmo contrato JSON do backend Python: a interface em /frontend
 * funciona sem alteração. Todas as rotas, validações e regras fiscais foram
 * portadas de backend/bemrecibo/main.py.
 */
import { buildPdf } from "./pdf";
import {
  brl,
  base64ToBytes,
  bytesToBase64,
  csvCell,
  detectImageType,
  formatDateBr,
  formatTaxId,
  nowIso,
  numberToWordsPt,
  toIsoDate,
} from "./services";
import type { DonationRow, DonorRow, Env, InstitutionRow } from "./types";

const JSON_TYPE = "application/json; charset=utf-8";
const MAX_IMAGE_BYTES = 700_000; // base64 cabe no limite de 1 MB por valor do D1
const MAX_PROOF_BYTES = 700_000;
const VALID_STATUSES = ["nao_habilitada", "habilitada"];

const json = (data: unknown, status = 200): Response =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": JSON_TYPE } });

const fail = (status: number, detail: string): Response => json({ detail }, status);

const corsHeaders = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,POST,PUT,DELETE,OPTIONS",
  "access-control-allow-headers": "content-type",
  "access-control-max-age": "86400",
};

function withCors(response: Response): Response {
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(corsHeaders)) headers.set(key, value);
  return new Response(response.body, { status: response.status, headers });
}

/* --------------------------------------------------------------------------
 * Instituição
 * ------------------------------------------------------------------------ */

const INSTITUTION_DEFAULTS = {
  name: "Instituto Pelo Bem",
  address: "Rua Pedro Henrique, 300 — Santo Amaro",
  city: "Recife - PE",
};

async function getInstitution(env: Env): Promise<InstitutionRow> {
  const existing = await env.DB.prepare("SELECT * FROM institution WHERE id = 1").first<InstitutionRow>();
  if (existing) return existing;

  await env.DB.prepare(
    "INSERT INTO institution (id, name, status, address, city, updated_at) VALUES (1, ?, 'nao_habilitada', ?, ?, ?)",
  )
    .bind(INSTITUTION_DEFAULTS.name, INSTITUTION_DEFAULTS.address, INSTITUTION_DEFAULTS.city, nowIso())
    .run();

  const created = await env.DB.prepare("SELECT * FROM institution WHERE id = 1").first<InstitutionRow>();
  if (!created) throw new Error("Não foi possível inicializar a instituição.");
  return created;
}

function institutionPayload(row: InstitutionRow) {
  return {
    name: row.name,
    status: row.status,
    cnpj: row.cnpj,
    address: row.address,
    city: row.city,
    phone: row.phone,
    email: row.email,
    site: row.site,
    signatory_name: row.signatory_name,
    signatory_role: row.signatory_role,
    has_logo: Boolean(row.logo_content),
    logo_filename: row.logo_filename,
    has_signature: Boolean(row.signature_content),
    signature_filename: row.signature_filename,
    has_proof: Boolean(row.proof_content),
    proof_filename: row.proof_filename,
    proof_uploaded_at: row.proof_uploaded_at,
    updated_at: row.updated_at,
  };
}

/* --------------------------------------------------------------------------
 * Serialização
 * ------------------------------------------------------------------------ */

function serializeDonation(row: DonationRow) {
  const amount = row.amount ?? row.estimated_value ?? null;
  return {
    id: row.id,
    number: row.number,
    donor_id: row.donor_id,
    donor_name: row.donor_name ?? "",
    tax_id: row.donor_tax_id ?? "",
    tax_id_formatted: formatTaxId(row.donor_tax_id ?? ""),
    person_type: row.donor_person_type ?? "",
    donation_type: row.donation_type,
    received_at: row.received_at,
    purpose: row.purpose,
    amount,
    amount_formatted: brl(amount),
    description: row.description,
    quantity: row.quantity,
    payment_method: row.payment_method,
    document_type: row.document_type,
    institution_status_snapshot: row.institution_status_snapshot,
    warning_applied: Boolean(row.warning_applied),
    voided: Boolean(row.voided),
    void_reason: row.void_reason,
    created_at: row.created_at,
  };
}

const DONATION_SELECT = `
  SELECT don.*, d.name AS donor_name, d.person_type AS donor_person_type,
         d.tax_id AS donor_tax_id, d.email AS donor_email, d.phone AS donor_phone,
         d.representative AS donor_representative
  FROM donations don
  JOIN donors d ON d.id = don.donor_id`;

/* --------------------------------------------------------------------------
 * Filtros e indicadores
 * ------------------------------------------------------------------------ */

interface FilterResult {
  where: string;
  params: unknown[];
}

function buildFilters(url: URL): FilterResult {
  const clauses: string[] = [];
  const params: unknown[] = [];

  const search = url.searchParams.get("search")?.trim();
  if (search) {
    clauses.push("(d.name LIKE ? OR d.tax_id LIKE ? OR don.number LIKE ?)");
    params.push(`%${search}%`, `%${search}%`, `%${search}%`);
  }
  const from = url.searchParams.get("date_from");
  if (from) {
    clauses.push("don.received_at >= ?");
    params.push(toIsoDate(from));
  }
  const to = url.searchParams.get("date_to");
  if (to) {
    clauses.push("don.received_at <= ?");
    params.push(toIsoDate(to));
  }
  const type = url.searchParams.get("donation_type");
  if (type === "financeira" || type === "bem") {
    clauses.push("don.donation_type = ?");
    params.push(type);
  }
  const status = url.searchParams.get("status");
  if (status === "ativas") clauses.push("(don.voided = 0 OR don.voided IS NULL)");
  else if (status === "canceladas") clauses.push("don.voided = 1");

  return { where: clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "", params };
}

async function listDonations(env: Env, url: URL): Promise<DonationRow[]> {
  const { where, params } = buildFilters(url);
  const limitParam = url.searchParams.get("limit");
  const offsetParam = url.searchParams.get("offset");

  let sql = `${DONATION_SELECT}${where} ORDER BY don.id DESC`;
  const bindings = [...params];

  if (limitParam) {
    const limit = Math.min(Math.max(Number(limitParam) || 0, 1), 1000);
    sql += " LIMIT ?";
    bindings.push(limit);
  }
  if (offsetParam) {
    const offset = Math.max(Number(offsetParam) || 0, 0);
    sql += " OFFSET ?";
    bindings.push(offset);
  }

  const result = await env.DB.prepare(sql).bind(...bindings).all<DonationRow>();
  return result.results ?? [];
}

async function computeStats(env: Env) {
  const institution = await getInstitution(env);
  const donations = await listDonations(env, new URL("https://local/stats"));
  const donorsCount =
    (await env.DB.prepare("SELECT COUNT(*) AS total FROM donors").first<{ total: number }>())?.total ?? 0;

  const active = donations.filter((row) => !row.voided);
  const financial = active.filter((row) => row.donation_type === "financeira");
  const goods = active.filter((row) => row.donation_type === "bem");

  const sum = (rows: DonationRow[], pick: (row: DonationRow) => number | null) =>
    rows.reduce((total, row) => total + (pick(row) ?? 0), 0);

  const totalFinancial = sum(financial, (row) => row.amount);
  const totalGoods = sum(goods, (row) => row.estimated_value);

  const monthlyMap = new Map<string, { total: number; count: number }>();
  for (const row of active) {
    const key = row.received_at.slice(0, 7);
    const entry = monthlyMap.get(key) ?? { total: 0, count: 0 };
    entry.total += row.amount ?? row.estimated_value ?? 0;
    entry.count += 1;
    monthlyMap.set(key, entry);
  }
  const monthly = [...monthlyMap.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([month, value]) => ({ month, total: Math.round(value.total * 100) / 100, count: value.count }));

  const donorMap = new Map<number, { id: number; name: string; person_type: string; tax_id: string; total: number; count: number }>();
  for (const row of active) {
    const entry = donorMap.get(row.donor_id) ?? {
      id: row.donor_id,
      name: row.donor_name ?? "",
      person_type: row.donor_person_type ?? "",
      tax_id: formatTaxId(row.donor_tax_id ?? ""),
      total: 0,
      count: 0,
    };
    entry.total += row.amount ?? row.estimated_value ?? 0;
    entry.count += 1;
    donorMap.set(row.donor_id, entry);
  }
  const topDonors = [...donorMap.values()]
    .sort((a, b) => b.total - a.total)
    .slice(0, 5)
    .map((entry) => ({
      ...entry,
      total: Math.round(entry.total * 100) / 100,
      total_formatted: brl(entry.total),
    }));

  const recent = [...active]
    .sort((a, b) => (a.received_at === b.received_at ? b.id - a.id : b.received_at.localeCompare(a.received_at)))
    .slice(0, 6);

  const average = financial.length ? totalFinancial / financial.length : 0;

  return {
    institution_status: institution.status,
    institution_name: institution.name,
    donations_count: active.length,
    cancelled_count: donations.filter((row) => row.voided).length,
    donors_count: donorsCount,
    financial_count: financial.length,
    goods_count: goods.length,
    total_financial: Math.round(totalFinancial * 100) / 100,
    total_goods: Math.round(totalGoods * 100) / 100,
    total_general: Math.round((totalFinancial + totalGoods) * 100) / 100,
    total_financial_formatted: brl(totalFinancial),
    total_goods_formatted: brl(totalGoods),
    total_general_formatted: brl(totalFinancial + totalGoods),
    average_ticket: Math.round(average * 100) / 100,
    average_ticket_formatted: brl(average),
    monthly,
    top_donors: topDonors,
    recent_donations: recent.map(serializeDonation),
  };
}

/* --------------------------------------------------------------------------
 * Validação do payload de doação
 * ------------------------------------------------------------------------ */

interface DonationInput {
  person_type: "PF" | "PJ";
  donor_name: string;
  tax_id: string;
  email: string | null;
  phone: string | null;
  representative: string | null;
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
}

type Validation = { ok: true; data: DonationInput } | { ok: false; message: string };

const text = (value: unknown): string => (typeof value === "string" ? value.trim() : "");

function validateDonation(body: Record<string, unknown>): Validation {
  const personType = text(body.person_type).toUpperCase();
  if (personType !== "PF" && personType !== "PJ") return { ok: false, message: "Tipo de doador inválido." };

  const donorName = text(body.donor_name);
  if (donorName.length < 2) return { ok: false, message: "Informe o nome do doador." };

  const taxId = text(body.tax_id);
  if (taxId.length < 5) return { ok: false, message: "Informe um CPF/CNPJ válido." };

  const donationType = text(body.donation_type);
  if (donationType !== "financeira" && donationType !== "bem") {
    return { ok: false, message: "Modalidade de doação inválida." };
  }

  const receivedAt = toIsoDate(text(body.received_at));
  if (!/^\d{4}-\d{2}-\d{2}$/.test(receivedAt)) return { ok: false, message: "Data de recebimento inválida." };

  const purpose = text(body.purpose);
  if (purpose.length < 2) return { ok: false, message: "Informe a finalidade da doação." };

  const toNumber = (value: unknown): number | null => {
    if (value === null || value === undefined || value === "") return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  };

  const amount = toNumber(body.amount);
  const quantity = toNumber(body.quantity);
  const estimatedValue = toNumber(body.estimated_value);

  if (donationType === "financeira") {
    if (!amount || amount <= 0) return { ok: false, message: "Doação financeira exige valor maior que zero." };
  } else {
    if (!text(body.description)) {
      return { ok: false, message: "Doação de bem/serviço exige descrição." };
    }
    if (!quantity || quantity <= 0) {
      return { ok: false, message: "Doação de bem/serviço exige quantidade." };
    }
    if (!estimatedValue || estimatedValue <= 0) {
      return { ok: false, message: "Doação de bem/serviço exige valor estimado." };
    }
  }

  return {
    ok: true,
    data: {
      person_type: personType,
      donor_name: donorName,
      tax_id: taxId,
      email: text(body.email) || null,
      phone: text(body.phone) || null,
      representative: text(body.representative) || null,
      donation_type: donationType,
      received_at: receivedAt,
      purpose,
      payment_method: text(body.payment_method) || null,
      amount: donationType === "financeira" ? amount : null,
      description: donationType === "bem" ? text(body.description) : null,
      quantity: donationType === "bem" ? quantity : null,
      estimated_value: donationType === "bem" ? estimatedValue : null,
      brand_model: text(body.brand_model) || null,
      fiscal_document: text(body.fiscal_document) || null,
      notes: text(body.notes) || null,
    },
  };
}

/* --------------------------------------------------------------------------
 * Uploads
 * ------------------------------------------------------------------------ */

async function readUpload(
  form: FormData,
  field: string,
  label: string,
  maxBytes: number,
  allowed: "image" | "any",
  kind: string,
): Promise<{ ok: true; base64: string; filename: string; contentType: string } | { ok: false; message: string }> {
  const file = form.get(field);
  if (!file || typeof (file as File).arrayBuffer !== "function") {
    return { ok: false, message: `Selecione o arquivo de ${label}.` };
  }
  const upload = file as File;
  const bytes = new Uint8Array(await upload.arrayBuffer());
  if (!bytes.length) return { ok: false, message: `O arquivo de ${label} está vazio.` };
  if (bytes.length > maxBytes) {
    return { ok: false, message: `O arquivo de ${label} excede ${(maxBytes / 1000).toFixed(0)} KB.` };
  }
  const imageType = detectImageType(bytes);
  if (allowed === "image" && !imageType) {
    return { ok: false, message: `Formato inválido para ${label}. Envie PNG ou JPEG.` };
  }
  const contentType = imageType === "png" ? "image/png" : imageType === "jpeg" ? "image/jpeg" : upload.type || "application/octet-stream";
  return {
    ok: true,
    base64: bytesToBase64(bytes),
    filename: upload.name || `${kind}.${imageType === "jpeg" ? "jpg" : "png"}`,
    contentType,
  };
}

function binaryResponse(bytes: Uint8Array, contentType: string, filename: string): Response {
  return new Response(bytes, {
    headers: {
      "content-type": contentType,
      "content-disposition": `inline; filename="${filename.replace(/["\\]/g, "")}"`,
      "cache-control": "no-store",
    },
  });
}

/* --------------------------------------------------------------------------
 * Handlers
 * ------------------------------------------------------------------------ */

async function handleRequest(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const method = request.method.toUpperCase();

  if (method === "OPTIONS") return withCors(new Response(null, { status: 204 }));

  // ------------------------------------------------------------- público --
  if (path === "/" && method === "GET") {
    if ((request.headers.get("accept") || "").includes("text/html")) return env.ASSETS.fetch(request);
    return json({ app: "BemRecibo", status: "online", docs: "/docs" });
  }

  if (path === "/health" && method === "GET") {
    return json({ status: "ok", version: "2.0.0-cloudflare" });
  }

  if (path === "/docs") {
    return json({
      app: "BemRecibo",
      runtime: "Cloudflare Workers",
      database: "D1",
      message: "A documentação interativa (Swagger) existe apenas no backend Python.",
    });
  }

  // --------------------------------------------------------- instituição --
  if (path === "/institution" && method === "GET") {
    return json(institutionPayload(await getInstitution(env)));
  }

  if (path === "/institution" && method === "PUT") {
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const editable = ["name", "cnpj", "address", "city", "phone", "email", "site", "signatory_name", "signatory_role"];
    const values = editable
      .filter((field) => body[field] !== undefined && body[field] !== null)
      .map((field) => [field, String(body[field]).trim()] as const);

    if (body.name !== undefined && String(body.name).trim().length < 2) {
      return fail(422, "Informe o nome da instituição.");
    }
    if (values.length) {
      const assignments = values.map(([field]) => `${field} = ?`).join(", ");
      await env.DB.prepare(`UPDATE institution SET ${assignments}, updated_at = ? WHERE id = 1`)
        .bind(...values.map(([, value]) => value), nowIso())
        .run();
    }
    return json({ message: "Dados institucionais atualizados.", ...institutionPayload(await getInstitution(env)) }, 200);
  }

  if (path === "/institution/status" && method === "PUT") {
    const status = url.searchParams.get("status") ?? "";
    if (!VALID_STATUSES.includes(status)) return fail(400, "Status inválido.");

    if (status === "habilitada") {
      const form = await request.formData().catch(() => null);
      if (!form) return fail(400, "Anexe o comprovante legal para habilitar a instituição.");
      const upload = await readUpload(form, "proof", "comprovante", MAX_PROOF_BYTES, "any", "comprovante");
      if (!upload.ok) return fail(400, upload.message);
      await env.DB.prepare(
        "UPDATE institution SET status = ?, proof_filename = ?, proof_content = ?, proof_uploaded_at = ?, updated_at = ? WHERE id = 1",
      )
        .bind(status, upload.filename, upload.base64, nowIso(), nowIso())
        .run();
    } else {
      await env.DB.prepare(
        "UPDATE institution SET status = ?, proof_filename = NULL, proof_content = NULL, proof_uploaded_at = NULL, updated_at = ? WHERE id = 1",
      )
        .bind(status, nowIso())
        .run();
    }
    const updated = await getInstitution(env);
    return json({ message: "Status atualizado.", status: updated.status, has_proof: Boolean(updated.proof_content) });
  }

  if (path === "/institution/proof" && method === "GET") {
    const institution = await getInstitution(env);
    if (!institution.proof_content) return fail(404, "Nenhum comprovante anexado.");
    const bytes = base64ToBytes(institution.proof_content);
    const type = detectImageType(bytes);
    return binaryResponse(
      bytes,
      bytes[0] === 0x25 ? "application/pdf" : type === "png" ? "image/png" : type === "jpeg" ? "image/jpeg" : "application/octet-stream",
      institution.proof_filename || "comprovante",
    );
  }

  // ---------------------------------------------- identidade visual --
  for (const kind of ["logo", "signature"] as const) {
    const label = kind === "logo" ? "logotipo" : "assinatura";
    if (path !== `/institution/${kind}`) continue;

    if (method === "GET") {
      const institution = await getInstitution(env);
      const content = kind === "logo" ? institution.logo_content : institution.signature_content;
      const filename = kind === "logo" ? institution.logo_filename : institution.signature_filename;
      if (!content) return fail(404, "Imagem não cadastrada.");
      const bytes = base64ToBytes(content);
      return binaryResponse(bytes, detectImageType(bytes) === "jpeg" ? "image/jpeg" : "image/png", filename || `${kind}.png`);
    }

    if (method === "PUT") {
      const form = await request.formData().catch(() => null);
      if (!form) return fail(400, `Envie o arquivo de ${label}.`);
      const upload = await readUpload(form, kind, label, MAX_IMAGE_BYTES, "image", kind);
      if (!upload.ok) return fail(400, upload.message);
      await env.DB.prepare(
        `UPDATE institution SET ${kind}_filename = ?, ${kind}_content = ?, updated_at = ? WHERE id = 1`,
      )
        .bind(upload.filename, upload.base64, nowIso())
        .run();
      return json({
        message: kind === "logo" ? "Logotipo atualizado." : "Assinatura atualizada.",
        ...institutionPayload(await getInstitution(env)),
      });
    }

    if (method === "DELETE") {
      await env.DB.prepare(
        `UPDATE institution SET ${kind}_filename = NULL, ${kind}_content = NULL, updated_at = ? WHERE id = 1`,
      )
        .bind(nowIso())
        .run();
      return json({
        message: kind === "logo" ? "Logotipo removido." : "Assinatura removida.",
        ...institutionPayload(await getInstitution(env)),
      });
    }
  }

  // -------------------------------------------------------------- doadores --
  if (path === "/donors" && method === "POST") {
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const personType = text(body.person_type).toUpperCase();
    const name = text(body.name);
    const taxId = text(body.tax_id);
    if (personType !== "PF" && personType !== "PJ") return fail(422, "Tipo de pessoa inválido.");
    if (name.length < 2) return fail(422, "Informe o nome do doador.");
    if (taxId.length < 5) return fail(422, "Informe um CPF/CNPJ válido.");

    const existing = await env.DB.prepare("SELECT id FROM donors WHERE tax_id = ?").bind(taxId).first<{ id: number }>();
    if (existing) return fail(409, "Já existe um doador com esse CPF/CNPJ.");

    const result = await env.DB.prepare(
      "INSERT INTO donors (person_type, name, tax_id, email, phone, representative, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
      .bind(personType, name, taxId, text(body.email) || null, text(body.phone) || null, text(body.representative) || null, nowIso())
      .run();

    const donor = await env.DB.prepare("SELECT id, person_type, name, tax_id, email, phone, representative FROM donors WHERE id = ?")
      .bind(result.meta.last_row_id)
      .first<DonorRow>();
    return json(donor, 200);
  }

  if (path === "/donors" && method === "GET") {
    const search = url.searchParams.get("search")?.trim();
    const personType = url.searchParams.get("person_type");
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (search) {
      clauses.push("(name LIKE ? OR tax_id LIKE ?)");
      params.push(`%${search}%`, `%${search}%`);
    }
    if (personType === "PF" || personType === "PJ") {
      clauses.push("person_type = ?");
      params.push(personType);
    }
    const where = clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "";
    const rows = await env.DB.prepare(
      `SELECT id, person_type, name, tax_id, email, phone, representative FROM donors${where} ORDER BY name COLLATE NOCASE`,
    )
      .bind(...params)
      .all<DonorRow>();
    return json(rows.results ?? []);
  }

  const donorMatch = path.match(/^\/donors\/(\d+)$/);
  if (donorMatch && method === "GET") {
    const donorId = Number(donorMatch[1]);
    const donor = await env.DB.prepare("SELECT * FROM donors WHERE id = ?").bind(donorId).first<DonorRow>();
    if (!donor) return fail(404, "Doador não encontrado.");

    const donations = (
      await env.DB.prepare(`${DONATION_SELECT} WHERE don.donor_id = ? ORDER BY don.received_at DESC, don.id DESC`)
        .bind(donorId)
        .all<DonationRow>()
    ).results ?? [];

    const active = donations.filter((row) => !row.voided);
    const total = active.reduce((sum, row) => sum + (row.amount ?? row.estimated_value ?? 0), 0);

    return json({
      id: donor.id,
      person_type: donor.person_type,
      name: donor.name,
      tax_id: donor.tax_id,
      tax_id_formatted: formatTaxId(donor.tax_id),
      email: donor.email,
      phone: donor.phone,
      representative: donor.representative,
      created_at: donor.created_at,
      donations_count: active.length,
      total_donated: Math.round(total * 100) / 100,
      total_donated_formatted: brl(total),
      donations: donations.map((row) => ({
        id: row.id,
        number: row.number,
        received_at: row.received_at,
        donation_type: row.donation_type,
        amount: row.amount ?? row.estimated_value ?? null,
        document_type: row.document_type,
        voided: Boolean(row.voided),
      })),
    });
  }

  // -------------------------------------------------------------- doações --
  if (path === "/donations" && method === "POST") {
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body) return fail(422, "Corpo da requisição inválido.");

    const parsed = validateDonation(body);
    if (!parsed.ok) return fail(422, parsed.message);
    const input = parsed.data;

    const institution = await getInstitution(env);
    if (institution.status === "habilitada" && !institution.proof_content) {
      return fail(409, "Habilitação sem comprovante. Operação bloqueada.");
    }

    let documentType: string;
    let warning: boolean;
    if (institution.status === "habilitada" && input.person_type === "PJ") {
      documentType = "Declaração de Doação Pós-Habilitação";
      warning = false;
    } else {
      documentType = input.person_type === "PF" ? "Recibo de Doação PF" : "Recibo de Doação PJ";
      warning = institution.status !== "habilitada";
    }
    if (input.donation_type === "bem") documentType = "Termo de Doação e Entrega";

    let donor = await env.DB.prepare("SELECT * FROM donors WHERE tax_id = ?").bind(input.tax_id).first<DonorRow>();
    if (donor && donor.person_type !== input.person_type) {
      return fail(409, "O tipo de pessoa diverge do cadastro existente.");
    }

    if (donor) {
      await env.DB.prepare("UPDATE donors SET name = ?, email = ?, phone = ?, representative = ? WHERE id = ?")
        .bind(input.donor_name, input.email, input.phone, input.representative ?? donor.representative, donor.id)
        .run();
    } else {
      const created = await env.DB.prepare(
        "INSERT INTO donors (person_type, name, tax_id, email, phone, representative, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
        .bind(input.person_type, input.donor_name, input.tax_id, input.email, input.phone, input.representative, nowIso())
        .run();
      donor = await env.DB.prepare("SELECT * FROM donors WHERE id = ?")
        .bind(created.meta.last_row_id)
        .first<DonorRow>();
    }
    if (!donor) return fail(409, "Não foi possível registrar o doador. Tente novamente.");

    const year = input.received_at.slice(0, 4);
    let lastError = "";

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const last = await env.DB.prepare(
        "SELECT number FROM donations WHERE number LIKE ? ORDER BY id DESC LIMIT 1",
      )
        .bind(`BR-${year}-%`)
        .first<{ number: string }>();

      let sequence = 1;
      if (last) {
        const parsedSequence = Number(last.number.split("-").pop());
        if (Number.isFinite(parsedSequence)) sequence = parsedSequence + 1;
      }
      const number = `BR-${year}-${String(sequence).padStart(6, "0")}`;

      try {
        const inserted = await env.DB.prepare(
          `INSERT INTO donations (
             number, donor_id, donation_type, received_at, purpose, payment_method, amount,
             description, quantity, estimated_value, brand_model, fiscal_document, notes,
             document_type, institution_status_snapshot, warning_applied, voided, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
        )
          .bind(
            number,
            donor.id,
            input.donation_type,
            input.received_at,
            input.purpose,
            input.payment_method,
            input.amount,
            input.description,
            input.quantity,
            input.estimated_value,
            input.brand_model,
            input.fiscal_document,
            input.notes,
            documentType,
            institution.status,
            warning ? 1 : 0,
            nowIso(),
          )
          .run();

        const donationId = inserted.meta.last_row_id;
        await env.DB.prepare("INSERT INTO documents (donation_id, document_type, filename, created_at) VALUES (?, ?, ?, ?)")
          .bind(donationId, documentType, `${number}.pdf`, nowIso())
          .run();

        return json({
          id: donationId,
          number,
          document_type: documentType,
          warning_applied: warning,
          pdf_url: `/documents/${donationId}/pdf`,
          message: "Doação registrada. Documento disponível para download.",
        });
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
        if (!/UNIQUE/i.test(lastError)) break;
      }
    }

    return fail(409, `Não foi possível gerar a numeração do documento: ${lastError}`);
  }

  if (path === "/donations" && method === "GET") {
    const rows = await listDonations(env, url);
    return json(rows.map(serializeDonation));
  }

  if (path === "/donations/export.csv" && method === "GET") {
    const rows = await listDonations(env, url);
    const header = [
      "Número", "Data de recebimento", "Doador", "Tipo de doador", "CPF/CNPJ",
      "Modalidade", "Valor (R$)", "Finalidade", "Forma de recebimento",
      "Documento emitido", "Status institucional", "Cancelada", "Motivo do cancelamento",
    ];
    const lines = [header.map(csvCell).join(";")];
    for (const row of rows) {
      lines.push(
        [
          row.number,
          formatDateBr(row.received_at),
          row.donor_name ?? "",
          row.donor_person_type ?? "",
          formatTaxId(row.donor_tax_id ?? ""),
          row.donation_type === "financeira" ? "Financeira" : "Bem/Serviço",
          (row.amount ?? row.estimated_value ?? 0).toFixed(2).replace(".", ","),
          row.purpose,
          row.payment_method ?? "",
          row.document_type,
          row.institution_status_snapshot,
          row.voided ? "Sim" : "Não",
          row.void_reason ?? "",
        ]
          .map(csvCell)
          .join(";"),
      );
    }
    const csv = `\uFEFF${lines.join("\r\n")}\r\n`;
    return new Response(csv, {
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="bemrecibo-doacoes-${new Date().toISOString().slice(0, 10).replace(/-/g, "")}.csv"`,
      },
    });
  }

  const donationMatch = path.match(/^\/donations\/(\d+)$/);
  if (donationMatch && method === "GET") {
    const row = await env.DB.prepare(`${DONATION_SELECT} WHERE don.id = ?`).bind(Number(donationMatch[1])).first<DonationRow>();
    if (!row) return fail(404, "Doação não encontrada.");
    const amount = row.amount ?? row.estimated_value ?? null;
    return json({
      ...serializeDonation(row),
      email: row.donor_email,
      phone: row.donor_phone,
      representative: row.donor_representative,
      brand_model: row.brand_model,
      fiscal_document: row.fiscal_document,
      notes: row.notes,
      estimated_value: row.estimated_value,
      quantity: row.quantity,
      amount_in_words: numberToWordsPt(amount),
    });
  }

  if (donationMatch && method === "DELETE") {
    const id = Number(donationMatch[1]);
    const row = await env.DB.prepare("SELECT id, voided FROM donations WHERE id = ?").bind(id).first<{ id: number; voided: number }>();
    if (!row) return fail(404, "Doação não encontrada.");
    const reason = url.searchParams.get("reason") || "Cancelamento solicitado pela gestão";
    if (!row.voided) {
      await env.DB.prepare("UPDATE donations SET voided = 1, void_reason = ?, voided_at = ? WHERE id = ?")
        .bind(reason.slice(0, 250), nowIso(), id)
        .run();
    }
    return json({
      message: "Doação cancelada. O registro permanece no histórico para auditoria.",
      id,
      voided: true,
    });
  }

  const restoreMatch = path.match(/^\/donations\/(\d+)\/restore$/);
  if (restoreMatch && method === "POST") {
    const id = Number(restoreMatch[1]);
    const row = await env.DB.prepare("SELECT id FROM donations WHERE id = ?").bind(id).first<{ id: number }>();
    if (!row) return fail(404, "Doação não encontrada.");
    await env.DB.prepare("UPDATE donations SET voided = 0, void_reason = NULL, voided_at = NULL WHERE id = ?").bind(id).run();
    return json({ message: "Doação reativada.", id, voided: false });
  }

  // ----------------------------------------------------------- indicadores --
  if (path === "/stats" && method === "GET") {
    return json(await computeStats(env));
  }

  // ------------------------------------------------------------- documentos --
  const pdfMatch = path.match(/^\/documents\/(\d+)\/pdf$/);
  if (pdfMatch && method === "GET") {
    const row = await env.DB.prepare(`${DONATION_SELECT} WHERE don.id = ?`).bind(Number(pdfMatch[1])).first<DonationRow>();
    if (!row) return fail(404, "Doação não encontrada.");

    const institution = await getInstitution(env);
    const donor = {
      name: row.donor_name ?? "",
      person_type: (row.donor_person_type ?? "PF") as "PF" | "PJ",
      tax_id: row.donor_tax_id ?? "",
      representative: row.donor_representative ?? null,
      email: row.donor_email ?? null,
      phone: row.donor_phone ?? null,
    };

    try {
      const pdf = await buildPdf(row, donor, institution);
      const disposition = url.searchParams.get("inline") === "true" ? "inline" : "attachment";
      return new Response(pdf, {
        headers: {
          "content-type": "application/pdf",
          "content-disposition": `${disposition}; filename="${row.number}.pdf"`,
          "cache-control": "no-store",
        },
      });
    } catch (error) {
      return fail(500, `Falha ao gerar o PDF: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // ------------------------------------------------------------ fallback --
  if (path.startsWith("/documents") || path.startsWith("/donations") || path.startsWith("/donors") ||
      path.startsWith("/institution") || path.startsWith("/stats")) {
    return fail(404, "Rota não encontrada.");
  }

  return env.ASSETS.fetch(request);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      return withCors(await handleRequest(request, env));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return withCors(fail(500, `Erro interno: ${message}`));
    }
  },
} satisfies ExportedHandler<Env>;
