/* ==========================================================================
   BemRecibo — camada de interface
   Conversa com a API do backend (FastAPI) e mantém o estado das telas.
   ========================================================================== */
(() => {
  "use strict";

  /* ------------------------------------------------------------ config --- */
  const resolveApiBase = () => {
    const configured = document.querySelector('meta[name="bemrecibo-api"]')?.content?.trim();
    if (configured) return configured.replace(/\/+$/, "");
    if (location.protocol === "file:") return "http://127.0.0.1:8000";
    const isLocal = ["localhost", "127.0.0.1"].includes(location.hostname);
    if (isLocal && location.port && location.port !== "8000") return "http://127.0.0.1:8000";
    return "";
  };

  const API = resolveApiBase();
  const $ = (id) => document.getElementById(id);
  const state = { donors: [], donations: [], stats: null, institution: null, view: "donation" };

  const VIEW_META = {
    dashboard: { eyebrow: "PAINEL", title: "Visão geral" },
    donation: { eyebrow: "OPERAÇÃO", title: "Nova doação" },
    history: { eyebrow: "CONSULTA", title: "Histórico" },
    donors: { eyebrow: "CADASTROS", title: "Doadores" },
    institution: { eyebrow: "CONFIGURAÇÃO", title: "Instituição" },
  };

  /* --------------------------------------------------------- utilitários -- */
  const escapeHtml = (value) =>
    String(value ?? "").replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  const money = (value) =>
    Number(value || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });

  const compactMoney = (value) => {
    const n = Number(value || 0);
    if (n >= 1000000) return `${(n / 1000000).toFixed(1).replace(".", ",")} mi`;
    if (n >= 1000) return `${(n / 1000).toFixed(1).replace(".", ",")} mil`;
    return n.toLocaleString("pt-BR", { maximumFractionDigits: 0 });
  };

  const dateBR = (iso) => {
    if (!iso) return "—";
    const [y, m, d] = String(iso).slice(0, 10).split("-");
    return y && m && d ? `${d}/${m}/${y}` : iso;
  };

  const todayISO = () => {
    const now = new Date();
    const offset = now.getTimezoneOffset() * 60000;
    return new Date(now.getTime() - offset).toISOString().slice(0, 10);
  };

  const onlyDigits = (value) => String(value || "").replace(/\D+/g, "");

  const maskTaxId = (value) => {
    const digits = onlyDigits(value).slice(0, 14);
    if (digits.length <= 11) {
      return digits
        .replace(/^(\d{3})(\d)/, "$1.$2")
        .replace(/^(\d{3})\.(\d{3})(\d)/, "$1.$2.$3")
        .replace(/\.(\d{3})(\d{1,2})$/, ".$1-$2");
    }
    return digits
      .replace(/^(\d{2})(\d)/, "$1.$2")
      .replace(/^(\d{2})\.(\d{3})(\d)/, "$1.$2.$3")
      .replace(/\.(\d{3})(\d)/, ".$1/$2")
      .replace(/(\d{4})(\d{1,2})$/, "$1-$2");
  };

  const parseMoney = (raw) => {
    if (raw === null || raw === undefined) return NaN;
    let text = String(raw).trim().replace(/[R$\s]/g, "");
    if (!text) return NaN;
    if (text.includes(",")) {
      text = text.replace(/\./g, "").replace(",", ".");
    } else {
      const parts = text.split(".");
      if (parts.length > 2) text = parts.join("");
      else if (parts.length === 2 && parts[1].length === 3) text = parts.join("");
    }
    const parsed = Number(text);
    return Number.isFinite(parsed) ? parsed : NaN;
  };

  const debounce = (fn, wait = 320) => {
    let timer;
    return (...args) => {
      clearTimeout(timer);
      timer = setTimeout(() => fn(...args), wait);
    };
  };

  /* ------------------------------------------------------------- toasts -- */
  function showToast(message, { type = "success", title } = {}) {
    const stack = $("toast-stack");
    const el = document.createElement("div");
    el.className = `toast${type === "error" ? " error" : ""}`;
    el.innerHTML = `<strong>${escapeHtml(title || (type === "error" ? "Não foi possível concluir" : "Tudo certo"))}</strong>${escapeHtml(message)}`;
    stack.appendChild(el);
    setTimeout(() => {
      el.style.opacity = "0";
      el.style.transform = "translateY(6px)";
      setTimeout(() => el.remove(), 260);
    }, type === "error" ? 6500 : 4200);
  }

  /* ---------------------------------------------------------------- api --- */
  class ApiError extends Error {
    constructor(message, status) {
      super(message);
      this.status = status;
    }
  }

  async function api(path, options = {}) {
    let response;
    try {
      response = await fetch(API + path, options);
    } catch {
      throw new ApiError("Não foi possível conectar ao servidor. Verifique sua conexão.", 0);
    }
    if (!response.ok) {
      let detail = `Erro ${response.status}`;
      try {
        const body = await response.json();
        if (typeof body.detail === "string") detail = body.detail;
        else if (Array.isArray(body.detail)) {
          detail = body.detail
            .map((item) => `${(item.loc || []).slice(-1)[0] || "campo"}: ${item.msg}`)
            .join(" · ");
        }
      } catch { /* corpo não JSON: mantém mensagem genérica */ }
      throw new ApiError(detail, response.status);
    }
    return response;
  }

  const apiJson = (path, options) => api(path, options).then((r) => r.json());

  const documentUrl = (id, inline = false) =>
    `${API}/documents/${id}/pdf${inline ? "?inline=true" : ""}`;

  /* ------------------------------------------------------------- diálogo -- */
  function confirmAction({ title, text, confirmLabel = "Confirmar", danger = false, requireReason = false }) {
    const dialog = $("confirm-dialog");
    $("confirm-title").textContent = title;
    $("confirm-text").textContent = text;
    $("confirm-reason").value = "";
    $("confirm-reason-wrap").classList.toggle("hidden", !requireReason);
    const okButton = $("confirm-ok");
    okButton.textContent = confirmLabel;
    okButton.className = danger ? "danger-btn" : "primary";
    dialog.returnValue = "";
    dialog.showModal();
    return new Promise((resolve) => {
      dialog.addEventListener(
        "close",
        () => {
          const ok = dialog.returnValue === "ok";
          const reason = $("confirm-reason").value.trim();
          if (ok && requireReason && !reason) {
            showToast("Informe o motivo do cancelamento.", { type: "error" });
            resolve({ ok: false, reason: "" });
            return;
          }
          resolve({ ok, reason });
        },
        { once: true }
      );
    });
  }

  /* --------------------------------------------------------- navegação ---- */
  function setView(view) {
    state.view = view;
    document.querySelectorAll(".nav").forEach((btn) =>
      btn.classList.toggle("active", btn.dataset.view === view));
    document.querySelectorAll(".view").forEach((section) =>
      section.classList.toggle("hidden", section.id !== `view-${view}`));
    const meta = VIEW_META[view] || VIEW_META.donation;
    $("page-eyebrow").textContent = meta.eyebrow;
    $("page-title").textContent = meta.title;
    closeSidebar();
    window.scrollTo({ top: 0, behavior: "smooth" });

    if (view === "dashboard") loadStats();
    if (view === "history") loadDonations();
    if (view === "donors") loadDonors();
    if (view === "institution") loadInstitution();
    if (view === "donation") loadDonorOptions();
  }

  document.querySelectorAll(".nav").forEach((btn) =>
    btn.addEventListener("click", () => setView(btn.dataset.view)));

  document.querySelectorAll("[data-goto]").forEach((btn) =>
    btn.addEventListener("click", () => setView(btn.dataset.goto)));

  $("quick-new").addEventListener("click", () => setView("donation"));

  const sidebar = $("sidebar");
  const closeSidebar = () => {
    sidebar.classList.remove("open");
    $("menu-btn").setAttribute("aria-expanded", "false");
  };
  $("menu-btn").addEventListener("click", () => {
    const open = sidebar.classList.toggle("open");
    $("menu-btn").setAttribute("aria-expanded", String(open));
  });

  /* ------------------------------------------------------- instituição --- */
  const STATUS_TEXT = {
    habilitada: "Instituição habilitada: documentos de PJ saem sem advertência fiscal.",
    nao_habilitada: "Pré-habilitação: todo documento emitido traz advertência fiscal.",
  };

  function paintInstitution(institution) {
    state.institution = institution;
    const habilitada = institution.status === "habilitada";

    $("status-dot").classList.toggle("ok", habilitada);
    $("status-label").textContent = habilitada ? "Habilitada" : "Pré-habilitação";
    $("status-detail").textContent = habilitada
      ? "Documentos fiscais liberados"
      : "Status institucional atual";

    const notice = $("notice");
    notice.classList.toggle("ok", habilitada);
    $("notice-text").textContent = habilitada
      ? "Instituição habilitada. Doações de pessoa jurídica geram declaração pós-habilitação sem advertência fiscal."
      : "Sistema em cenário de pré-habilitação. Os documentos emitidos terão advertência fiscal.";

    const badge = $("inst-status-badge");
    badge.textContent = habilitada ? "Habilitada" : "Pré-habilitação";
    badge.classList.toggle("ok", habilitada);
    $("inst-status-text").textContent = STATUS_TEXT[institution.status] || "";
    $("download-proof").classList.toggle("hidden", !institution.has_proof);
    $("disable-btn").disabled = !habilitada;

    $("inst-name").value = institution.name || "";
    $("inst-cnpj").value = institution.cnpj || "";
    $("inst-phone").value = institution.phone || "";
    $("inst-address").value = institution.address || "";
    $("inst-city").value = institution.city || "";
    $("inst-email").value = institution.email || "";
    $("inst-site").value = institution.site || "";
  }

  async function loadInstitution() {
    try {
      paintInstitution(await apiJson("/institution"));
    } catch (error) {
      showToast(error.message, { type: "error" });
    }
  }

  $("institution-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const payload = {
      name: $("inst-name").value.trim(),
      cnpj: $("inst-cnpj").value.trim(),
      phone: $("inst-phone").value.trim(),
      address: $("inst-address").value.trim(),
      city: $("inst-city").value.trim(),
      email: $("inst-email").value.trim(),
      site: $("inst-site").value.trim(),
    };
    if (payload.name.length < 2) {
      showToast("Informe o nome da instituição.", { type: "error" });
      return;
    }
    try {
      paintInstitution(await apiJson("/institution", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      }));
      const message = $("institution-message");
      message.classList.remove("error");
      message.textContent = "Dados salvos. Novos PDFs já usam essas informações.";
      showToast("Dados institucionais atualizados. Novos PDFs já usam essas informações.");
    } catch (error) {
      const message = $("institution-message");
      message.textContent = error.message;
      message.classList.add("error");
      showToast(error.message, { type: "error" });
    }
  });

  $("proof-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const file = $("proof_file").files[0];
    if (!file) {
      showToast("Anexe o comprovante legal em PDF ou imagem para habilitar.", { type: "error" });
      return;
    }
    const body = new FormData();
    body.append("proof", file);
    try {
      const result = await apiJson("/institution/status?status=habilitada", { method: "PUT", body });
      $("proof_file").value = "";
      await loadInstitution();
      const message = $("proof-message");
      message.classList.remove("error");
      message.textContent = "Habilitação registrada com comprovante anexado.";
      showToast(result.message || "Instituição habilitada.", { title: "Habilitação registrada" });
    } catch (error) {
      const message = $("proof-message");
      message.textContent = error.message;
      message.classList.add("error");
      showToast(error.message, { type: "error" });
    }
  });

  $("disable-btn").addEventListener("click", async () => {
    const { ok } = await confirmAction({
      title: "Voltar para pré-habilitação?",
      text: "O comprovante anexado será removido e os próximos documentos voltam a ter advertência fiscal.",
      confirmLabel: "Voltar para pré-habilitação",
      danger: true,
    });
    if (!ok) return;
    try {
      await apiJson("/institution/status?status=nao_habilitada", { method: "PUT" });
      await loadInstitution();
      const message = $("proof-message");
      message.classList.remove("error");
      message.textContent = "Instituição em pré-habilitação. Comprovante removido.";
      showToast("Instituição voltou para o cenário de pré-habilitação.");
    } catch (error) {
      showToast(error.message, { type: "error" });
    }
  });

  $("download-proof").addEventListener("click", () => {
    if (!state.institution?.has_proof) {
      showToast("Nenhum comprovante anexado.", { type: "error" });
      return;
    }
    window.open(`${API}/institution/proof`, "_blank");
  });

  /* ----------------------------------------------------------- doadores --- */
  async function loadDonorOptions() {
    try {
      state.donors = await apiJson("/donors");
      $("donor_select").innerHTML =
        '<option value="">Selecione (opcional)</option>' +
        state.donors
          .map((d) => `<option value="${d.id}">${escapeHtml(d.name)} (${d.person_type})</option>`)
          .join("");
    } catch (error) {
      console.warn("Não foi possível carregar doadores:", error.message);
    }
  }

  function donorRows(donors) {
    if (!donors.length) {
      return `<tr><td colspan="6" class="table-empty"><b>Nenhum doador encontrado</b>Cadastre o primeiro doador ou ajuste a busca.</td></tr>`;
    }
    return donors
      .map(
        (d) => `<tr>
          <td class="cell-muted">#${d.id}</td>
          <td class="cell-name" title="${escapeHtml(d.name)}">${escapeHtml(d.name)}</td>
          <td><span class="tag ${d.person_type === "PF" ? "neutral" : "ok"}">${d.person_type}</span></td>
          <td>${escapeHtml(maskTaxId(d.tax_id) || d.tax_id)}</td>
          <td class="cell-muted">${escapeHtml(d.email || d.phone || "—")}</td>
          <td class="actions-col">
            <div class="row-actions">
              <button class="link-btn" data-donor-view="${d.id}">Detalhes</button>
              <button class="link-btn" data-donor-use="${d.id}">Nova doação</button>
            </div>
          </td>
        </tr>`
      )
      .join("");
  }

  async function loadDonors() {
    const params = new URLSearchParams();
    const term = $("donor-search").value.trim();
    const type = $("donor-type-filter").value;
    if (term) params.set("search", term);
    if (type) params.set("person_type", type);
    try {
      state.donors = await apiJson(`/donors?${params.toString()}`);
      $("donor-table").innerHTML = donorRows(state.donors);
      $("donors-count").textContent = `${state.donors.length} doador(es) encontrado(s)`;
      const select = $("donor_select");
      select.innerHTML =
        '<option value="">Selecione (opcional)</option>' +
        state.donors
          .map((d) => `<option value="${d.id}">${escapeHtml(d.name)} (${d.person_type})</option>`)
          .join("");
    } catch (error) {
      $("donor-table").innerHTML = `<tr><td colspan="6" class="table-empty">${escapeHtml(error.message)}</td></tr>`;
      showToast(error.message, { type: "error" });
    }
  }

  $("donor-search").addEventListener("input", debounce(loadDonors, 340));
  $("donor-type-filter").addEventListener("change", loadDonors);

  $("donor-table").addEventListener("click", async (event) => {
    const viewButton = event.target.closest("[data-donor-view]");
    const useButton = event.target.closest("[data-donor-use]");

    if (viewButton) {
      try {
        const detail = await apiJson(`/donors/${viewButton.dataset.donorView}`);
        openDonorDialog(detail);
      } catch (error) {
        showToast(error.message, { type: "error" });
      }
      return;
    }

    if (useButton) {
      const donor = state.donors.find((d) => String(d.id) === useButton.dataset.donorUse);
      if (!donor) return;
      setView("donation");
      $("donor_type").value = donor.person_type;
      $("donor_select").value = String(donor.id);
      $("donor_name").value = donor.name;
      $("tax_id").value = maskTaxId(donor.tax_id);
      $("email").value = donor.email || "";
      $("phone").value = donor.phone || "";
      $("representative").value = donor.representative || "";
      $("representative-wrap").classList.toggle("hidden", donor.person_type !== "PJ");
      updateTaxHint();
    }
  });

  function openDonorDialog(donor) {
    $("donor-dialog-title").textContent = donor.name;
    const rows = donor.donations.length
      ? donor.donations
          .map(
            (d) => `<tr class="${d.voided ? "is-voided" : ""}">
              <td class="doc-number">${escapeHtml(d.number)}</td>
              <td>${dateBR(d.received_at)}</td>
              <td>${d.donation_type === "financeira" ? "Financeira" : "Bem/Serviço"}</td>
              <td class="num">${money(d.amount)}</td>
              <td><a class="link-btn" target="_blank" rel="noopener" href="${documentUrl(d.id)}">PDF ↗</a></td>
            </tr>`
          )
          .join("")
      : `<tr><td colspan="5" class="table-empty">Nenhuma doação registrada.</td></tr>`;

    $("donor-dialog-body").innerHTML = `
      <div class="donor-summary">
        <div class="summary-item"><small>Documento</small><b>${escapeHtml(donor.tax_id_formatted || donor.tax_id)}</b></div>
        <div class="summary-item"><small>Tipo</small><b>${donor.person_type === "PF" ? "Pessoa Física" : "Pessoa Jurídica"}</b></div>
        <div class="summary-item"><small>Doações ativas</small><b>${donor.donations_count}</b></div>
        <div class="summary-item"><small>Total doado</small><b>${escapeHtml(donor.total_donated_formatted)}</b></div>
      </div>
      <p class="cell-muted">${escapeHtml(donor.email || "sem e-mail")} · ${escapeHtml(donor.phone || "sem telefone")}${donor.representative ? ` · Resp.: ${escapeHtml(donor.representative)}` : ""}</p>
      <div class="table-wrap">
        <table>
          <thead><tr><th>Número</th><th>Data</th><th>Modalidade</th><th class="num">Valor</th><th>Documento</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`;
    $("donor-dialog").showModal();
  }

  $("donor-dialog-close").addEventListener("click", () => $("donor-dialog").close());

  $("donor-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const message = $("donor-message");
    message.classList.remove("error");
    const payload = {
      person_type: $("new_type").value,
      name: $("new_name").value.trim(),
      tax_id: $("new_tax_id").value.trim(),
      email: $("new_email").value.trim() || null,
      phone: $("new_phone").value.trim() || null,
      representative: $("new_representative").value.trim() || null,
    };
    if (payload.name.length < 2) {
      message.textContent = "Informe o nome do doador.";
      message.classList.add("error");
      return;
    }
    if (payload.tax_id.length < 5) {
      message.textContent = "Informe um CPF/CNPJ válido.";
      message.classList.add("error");
      return;
    }
    try {
      message.textContent = "Salvando…";
      const created = await apiJson("/donors", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      event.target.reset();
      message.textContent = "";
      showToast(`Doador ${created.name} cadastrado.`);
      await loadDonors();
    } catch (error) {
      message.textContent = error.message;
      message.classList.add("error");
      showToast(error.message, { type: "error" });
    }
  });

  $("new_tax_id").addEventListener("input", (event) => {
    event.target.value = maskTaxId(event.target.value);
  });

  /* --------------------------------------------------- formulário doação -- */
  const taxHint = () => {
    const digits = onlyDigits($("tax_id").value);
    const hint = $("tax-id-hint");
    hint.classList.remove("error");
    if (!digits) {
      hint.textContent = "";
      return;
    }
    if (digits.length === 11) hint.textContent = "CPF reconhecido (11 dígitos).";
    else if (digits.length === 14) hint.textContent = "CNPJ reconhecido (14 dígitos).";
    else {
      hint.textContent = `Atenção: CPF tem 11 dígitos e CNPJ tem 14 (informado: ${digits.length}).`;
      hint.classList.add("error");
    }
  };
  const updateTaxHint = taxHint;

  $("tax_id").addEventListener("input", (event) => {
    event.target.value = maskTaxId(event.target.value);
    taxHint();
  });

  const moneyHint = (input, hint) => {
    const parsed = parseMoney(input.value);
    hint.textContent = Number.isNaN(parsed) || parsed <= 0 ? "" : `= ${money(parsed)}`;
  };

  ["amount", "estimated_value"].forEach((id) => {
    const input = $(id);
    const hint = $(id === "amount" ? "amount-hint" : "estimated-hint");
    input.addEventListener("input", () => moneyHint(input, hint));
    input.addEventListener("blur", () => {
      const parsed = parseMoney(input.value);
      if (!Number.isNaN(parsed) && parsed > 0) {
        input.value = parsed.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      }
      moneyHint(input, hint);
    });
  });

  function updateRuleText() {
    const personType = $("donor_type").value;
    const modality = $("donation_type").value;
    const habilitada = state.institution?.status === "habilitada";
    let text;
    if (modality === "bem") {
      text = "Termo de Doação e Entrega" +
        (habilitada ? " sem advertência fiscal." : " com advertência fiscal (pré-habilitação).");
    } else if (personType === "PJ" && habilitada) {
      text = "Declaração de Doação Pós-Habilitação, sem advertência fiscal.";
    } else {
      const doc = personType === "PF" ? "Recibo de Doação PF" : "Recibo de Doação PJ";
      text = doc + (habilitada ? ", sem advertência fiscal." : " com advertência fiscal (pré-habilitação).");
    }
    $("rule-text").textContent = text;
  }

  $("donation_type").addEventListener("change", () => {
    const isGoods = $("donation_type").value === "bem";
    $("goods-fields").classList.toggle("hidden", !isGoods);
    $("financial-fields").classList.toggle("hidden", isGoods);
    $("amount").required = !isGoods;
    $("estimated_value").required = isGoods;
    $("description").required = isGoods;
    updateRuleText();
  });

  $("donor_type").addEventListener("change", () => {
    $("representative-wrap").classList.toggle("hidden", $("donor_type").value !== "PJ");
    $("donor_select").value = "";
    updateRuleText();
  });

  $("donor_select").addEventListener("change", () => {
    const donor = state.donors.find((d) => String(d.id) === $("donor_select").value);
    if (!donor) return;
    $("donor_type").value = donor.person_type;
    $("donor_name").value = donor.name;
    $("tax_id").value = maskTaxId(donor.tax_id);
    $("email").value = donor.email || "";
    $("phone").value = donor.phone || "";
    $("representative").value = donor.representative || "";
    $("representative-wrap").classList.toggle("hidden", donor.person_type !== "PJ");
    updateRuleText();
    taxHint();
  });

  $("reset-donation").addEventListener("click", () => {
    setTimeout(() => {
      $("received_at").value = todayISO();
      $("purpose").value = "Apoio às atividades assistenciais";
      $("donor_select").value = "";
      $("representative-wrap").classList.add("hidden");
      $("goods-fields").classList.add("hidden");
      $("financial-fields").classList.remove("hidden");
      $("form-message").textContent = "";
      ["amount-hint", "estimated-hint", "tax-id-hint"].forEach((id) => ($(id).textContent = ""));
      updateRuleText();
    }, 0);
  });

  $("donation-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const message = $("form-message");
    const submit = $("submit-donation");
    message.classList.remove("error");
    message.textContent = "";

    const isGoods = $("donation_type").value === "bem";
    const payload = {
      person_type: $("donor_type").value,
      donor_name: $("donor_name").value.trim(),
      tax_id: $("tax_id").value.trim(),
      email: $("email").value.trim() || null,
      phone: $("phone").value.trim() || null,
      representative: $("representative").value.trim() || null,
      donation_type: $("donation_type").value,
      received_at: $("received_at").value,
      purpose: $("purpose").value.trim(),
      payment_method: $("payment_method").value.trim() || null,
      notes: $("notes").value.trim() || null,
      amount: isGoods ? null : parseMoney($("amount").value),
      description: isGoods ? $("description").value.trim() : null,
      quantity: isGoods ? Number($("quantity").value) : null,
      estimated_value: isGoods ? parseMoney($("estimated_value").value) : null,
      brand_model: isGoods ? $("brand_model").value.trim() || null : null,
      fiscal_document: isGoods ? $("fiscal_document").value.trim() || null : null,
    };

    const fail = (text) => {
      message.textContent = text;
      message.classList.add("error");
      showToast(text, { type: "error" });
    };

    if (payload.donor_name.length < 2) return fail("Informe o nome do doador.");
    if (payload.tax_id.length < 5) return fail("Informe o CPF/CNPJ do doador.");
    if (!payload.received_at) return fail("Informe a data de recebimento.");
    if (payload.purpose.length < 2) return fail("Informe a finalidade da doação.");
    if (isGoods) {
      if (!payload.description) return fail("Descreva o bem ou serviço doado.");
      if (!Number.isFinite(payload.estimated_value) || payload.estimated_value <= 0) {
        return fail("Informe o valor de mercado estimado do bem.");
      }
      if (!Number.isFinite(payload.quantity) || payload.quantity <= 0) {
        return fail("Informe a quantidade doada.");
      }
    } else if (!Number.isFinite(payload.amount) || payload.amount <= 0) {
      return fail("Informe o valor da doação financeira.");
    }

    submit.disabled = true;
    message.textContent = "Validando e registrando…";
    try {
      const result = await apiJson("/donations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      message.textContent = "";
      showToast(`Doação ${result.number} registrada e documento gerado.`, { title: "Doação registrada" });
      window.open(documentUrl(result.id), "_blank", "noopener");
      $("donor_select").value = "";
      $("donor_name").value = "";
      $("tax_id").value = "";
      $("email").value = "";
      $("phone").value = "";
      $("representative").value = "";
      $("notes").value = "";
      $("description").value = "";
      $("amount").value = "";
      $("estimated_value").value = "";
      $("brand_model").value = "";
      $("fiscal_document").value = "";
      $("quantity").value = "1";
      $("amount-hint").textContent = "";
      $("estimated-hint").textContent = "";
      $("tax-id-hint").textContent = "";
      $("received_at").value = todayISO();
      await loadDonorOptions();
    } catch (error) {
      message.textContent = error.message;
      message.classList.add("error");
      showToast(error.message, { type: "error" });
    } finally {
      submit.disabled = false;
    }
  });

  /* ----------------------------------------------------------- histórico -- */
  function historyParams() {
    const params = new URLSearchParams();
    const term = $("history-search").value.trim();
    if (term) params.set("search", term);
    if ($("filter-from").value) params.set("date_from", $("filter-from").value);
    if ($("filter-to").value) params.set("date_to", $("filter-to").value);
    if ($("filter-type").value) params.set("donation_type", $("filter-type").value);
    params.set("status", $("filter-status").value || "todas");
    return params;
  }

  function donationRows(donations) {
    if (!donations.length) {
      return `<tr><td colspan="8" class="table-empty"><b>Nenhuma doação encontrada</b>Ajuste os filtros ou registre uma nova doação.</td></tr>`;
    }
    return donations
      .map(
        (d) => `<tr class="${d.voided ? "is-voided" : ""}">
          <td class="doc-number">${escapeHtml(d.number)}</td>
          <td>${dateBR(d.received_at)}</td>
          <td class="cell-name" title="${escapeHtml(d.donor_name)}">${escapeHtml(d.donor_name)}
            <small class="cell-muted">${escapeHtml(d.tax_id_formatted || d.tax_id)}</small></td>
          <td>${d.person_type}</td>
          <td>${d.donation_type === "financeira" ? "Financeira" : "Bem/Serviço"}</td>
          <td class="num">${money(d.amount)}</td>
          <td>${d.voided ? '<span class="tag void">Cancelada</span>' : `<span class="tag ${d.warning_applied ? "warn" : "ok"}">${escapeHtml(d.document_type)}</span>`}</td>
          <td class="actions-col">
            <div class="row-actions">
              <a class="link-btn" target="_blank" rel="noopener" href="${documentUrl(d.id)}">PDF ↗</a>
              ${d.voided
                ? `<button class="link-btn" data-restore="${d.id}">Reativar</button>`
                : `<button class="link-btn danger" data-void="${d.id}">Cancelar</button>`}
            </div>
          </td>
        </tr>`
      )
      .join("");
  }

  async function loadDonations() {
    const params = historyParams();
    try {
      state.donations = await apiJson(`/donations?${params.toString()}`);
      $("history-table").innerHTML = donationRows(state.donations);
      const total = state.donations
        .filter((d) => !d.voided)
        .reduce((sum, d) => sum + Number(d.amount || 0), 0);
      $("history-count").textContent =
        `${state.donations.length} registro(s) · total ativo ${money(total)}`;
    } catch (error) {
      $("history-table").innerHTML = `<tr><td colspan="8" class="table-empty">${escapeHtml(error.message)}</td></tr>`;
      showToast(error.message, { type: "error" });
    }
  }

  $("history-search").addEventListener("input", debounce(loadDonations, 340));
  ["filter-from", "filter-to", "filter-type", "filter-status"].forEach((id) =>
    $(id).addEventListener("change", loadDonations));

  $("clear-filters").addEventListener("click", () => {
    $("history-search").value = "";
    $("filter-from").value = "";
    $("filter-to").value = "";
    $("filter-type").value = "";
    $("filter-status").value = "ativas";
    loadDonations();
  });

  $("export-csv").addEventListener("click", () => {
    const params = historyParams();
    window.location.href = `${API}/donations/export.csv?${params.toString()}`;
    showToast("Download do CSV iniciado.", { title: "Exportação" });
  });

  $("history-table").addEventListener("click", async (event) => {
    const voidButton = event.target.closest("[data-void]");
    const restoreButton = event.target.closest("[data-restore]");

    if (voidButton) {
      const id = voidButton.dataset.void;
      const donation = state.donations.find((d) => String(d.id) === id);
      const { ok, reason } = await confirmAction({
        title: "Cancelar esta doação?",
        text: `O documento ${donation?.number || ""} ficará marcado como cancelado. O registro permanece no histórico para auditoria.`,
        confirmLabel: "Cancelar doação",
        danger: true,
        requireReason: true,
      });
      if (!ok) return;
      try {
        await apiJson(`/donations/${id}?reason=${encodeURIComponent(reason)}`, { method: "DELETE" });
        showToast("Doação cancelada. O registro segue disponível no histórico.");
        await loadDonations();
      } catch (error) {
        showToast(error.message, { type: "error" });
      }
      return;
    }

    if (restoreButton) {
      try {
        await apiJson(`/donations/${restoreButton.dataset.restore}/restore`, { method: "POST" });
        showToast("Doação reativada.");
        await loadDonations();
      } catch (error) {
        showToast(error.message, { type: "error" });
      }
    }
  });

  /* -------------------------------------------------------- visão geral --- */
  function renderChart(monthly) {
    const container = $("chart");
    const months = [];
    const now = new Date();
    for (let index = 5; index >= 0; index -= 1) {
      const date = new Date(now.getFullYear(), now.getMonth() - index, 1);
      const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
      const found = monthly.find((item) => item.month === key);
      months.push({
        key,
        label: date.toLocaleDateString("pt-BR", { month: "short" }).replace(".", ""),
        total: found ? found.total : 0,
        count: found ? found.count : 0,
      });
    }
    const max = Math.max(...months.map((m) => m.total), 0);
    if (!max) {
      container.innerHTML = '<p class="chart-empty">Nenhuma doação registrada ainda. Os valores aparecerão aqui.</p>';
      return;
    }
    container.innerHTML = months
      .map((month) => {
        const height = Math.max((month.total / max) * 100, month.total > 0 ? 4 : 1.5);
        const title = `${month.label}: ${money(month.total)} · ${month.count} doação(ões)`;
        return `<div class="chart-col" title="${escapeHtml(title)}">
          <span class="chart-value">${month.total ? compactMoney(month.total) : ""}</span>
          <div class="chart-bar-wrap">
            <div class="chart-bar" style="height:${height}%;${month.total ? "" : "background:#e6ece7;"}"></div>
          </div>
          <span class="chart-label">${escapeHtml(month.label)}</span>
        </div>`;
      })
      .join("");
  }

  function renderTopDonors(donors) {
    const list = $("top-donors");
    if (!donors.length) {
      list.innerHTML = '<li class="empty-inline">Sem doações registradas até o momento.</li>';
      return;
    }
    list.innerHTML = donors
      .map(
        (donor, index) => `<li class="rank-item">
          <span class="rank-pos">${index + 1}</span>
          <div class="rank-info">
            <b title="${escapeHtml(donor.name)}">${escapeHtml(donor.name)}</b>
            <small>${donor.person_type} · ${escapeHtml(donor.tax_id)} · ${donor.count} doação(ões)</small>
          </div>
          <span class="rank-value">${escapeHtml(donor.total_formatted)}</span>
        </li>`
      )
      .join("");
  }

  function renderRecent(donations) {
    const table = $("recent-table");
    if (!donations.length) {
      table.innerHTML = `<tr><td colspan="6" class="table-empty"><b>Nenhuma doação ainda</b>Comece registrando a primeira doação.</td></tr>`;
      return;
    }
    table.innerHTML = donations
      .map(
        (d) => `<tr>
          <td class="doc-number">${escapeHtml(d.number)}</td>
          <td>${dateBR(d.received_at)}</td>
          <td class="cell-name" title="${escapeHtml(d.donor_name)}">${escapeHtml(d.donor_name)}</td>
          <td>${d.donation_type === "financeira" ? "Financeira" : "Bem/Serviço"}</td>
          <td class="num">${money(d.amount)}</td>
          <td><a class="link-btn" target="_blank" rel="noopener" href="${documentUrl(d.id)}">PDF ↗</a></td>
        </tr>`
      )
      .join("");
  }

  async function loadStats() {
    try {
      const stats = await apiJson("/stats");
      state.stats = stats;
      $("kpi-total").textContent = stats.total_general_formatted;
      $("kpi-total-hint").textContent =
        `Financeiro ${stats.total_financial_formatted} · bens ${stats.total_goods_formatted}`;
      $("kpi-count").textContent = stats.donations_count;
      $("kpi-count-hint").textContent =
        `${stats.financial_count} financeira(s) · ${stats.goods_count} de bens` +
        (stats.cancelled_count ? ` · ${stats.cancelled_count} cancelada(s)` : "");
      $("kpi-donors").textContent = stats.donors_count;
      $("kpi-average").textContent = stats.average_ticket_formatted;
      renderChart(stats.monthly || []);
      renderTopDonors(stats.top_donors || []);
      renderRecent(stats.recent_donations || []);
    } catch (error) {
      showToast(error.message, { type: "error" });
    }
  }

  /* ------------------------------------------------------------- início --- */
  async function checkHealth() {
    try {
      await api("/health");
      $("footer-status").textContent = `API conectada${API ? ` · ${API}` : ""}`;
    } catch {
      $("footer-status").textContent = "API indisponível — verifique se o servidor está em execução";
    }
  }

  async function init() {
    $("received_at").value = todayISO();
    $("env-pill").textContent =
      ["localhost", "127.0.0.1"].includes(location.hostname) || location.protocol === "file:"
        ? "Ambiente: local"
        : "Ambiente: produção";

    await loadInstitution();
    updateRuleText();
    await loadDonorOptions();
    checkHealth();
    setView("donation");
  }

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeSidebar();
  });

  init();
})();
