from tests.conftest import GOODS_DONATION, PF_DONATION, PJ_DONATION


def test_health_and_root(client):
    assert client.get("/health").json()["status"] == "ok"
    root = client.get("/").json()
    assert root["app"] == "BemRecibo"
    assert root["status"] == "online"


def test_institution_defaults(client):
    data = client.get("/institution").json()
    assert data["status"] == "nao_habilitada"
    assert data["has_proof"] is False
    assert data["name"] == "Instituto Pelo Bem"


def test_institution_details_update(client):
    response = client.put(
        "/institution",
        json={"cnpj": "12.345.678/0001-90", "phone": "(81) 3222-1010"},
    )
    assert response.status_code == 200
    assert response.json()["cnpj"] == "12.345.678/0001-90"

    pdf = client.get("/documents/1/pdf")
    assert pdf.status_code == 404  # nenhuma doação ainda


def test_donor_creation_and_conflict(client):
    payload = {
        "person_type": "PF",
        "name": "Maria de Souza Lima",
        "tax_id": "123.456.789-01",
    }
    assert client.post("/donors", json=payload).status_code == 200
    assert client.post("/donors", json=payload).status_code == 409


def test_donor_search_and_filter(client):
    client.post("/donors", json={"person_type": "PF", "name": "Ana Beatriz", "tax_id": "11122233344"})
    client.post("/donors", json={"person_type": "PJ", "name": "Empresa X", "tax_id": "11222333000144"})

    assert len(client.get("/donors").json()) == 2
    assert len(client.get("/donors?search=Ana").json()) == 1
    assert len(client.get("/donors?person_type=PJ").json()) == 1


def test_create_financial_donation_generates_document(client, sample_donation):
    assert sample_donation["number"] == "BR-2026-000001"
    assert sample_donation["document_type"] == "Recibo de Doação PF"
    assert sample_donation["warning_applied"] is True

    pdf = client.get(f"/documents/{sample_donation['id']}/pdf")
    assert pdf.status_code == 200
    assert pdf.headers["content-type"] == "application/pdf"
    assert "attachment" in pdf.headers["content-disposition"]


def test_sequential_numbering(client):
    first = client.post("/donations", json=PF_DONATION).json()
    second = client.post("/donations", json={**PF_DONATION, "amount": 10}).json()
    assert first["number"] == "BR-2026-000001"
    assert second["number"] == "BR-2026-000002"


def test_reusing_donor_does_not_duplicate(client):
    client.post("/donations", json=PF_DONATION)
    client.post("/donations", json={**PF_DONATION, "amount": 99})
    assert len(client.get("/donors").json()) == 1
    assert len(client.get("/donations").json()) == 2


def test_goods_donation_requires_fields(client):
    response = client.post("/donations", json={**GOODS_DONATION, "quantity": None})
    assert response.status_code == 422


def test_goods_donation_generates_term(client):
    response = client.post("/donations", json=GOODS_DONATION)
    assert response.status_code == 200
    data = response.json()
    assert data["document_type"] == "Termo de Doação e Entrega"
    pdf = client.get(f"/documents/{data['id']}/pdf")
    assert pdf.status_code == 200
    assert len(pdf.content) > 2000


def test_financial_donation_requires_amount(client):
    payload = {**PF_DONATION}
    payload.pop("amount")
    assert client.post("/donations", json=payload).status_code == 422


def test_person_type_mismatch_conflict(client):
    client.post("/donations", json=PF_DONATION)
    conflict = client.post("/donations", json={**PJ_DONATION, "tax_id": PF_DONATION["tax_id"]})
    assert conflict.status_code == 409


def test_habilitacao_requires_proof(client):
    assert client.put("/institution/status?status=habilitada").status_code == 400
    assert client.put("/institution/status?status=invalido").status_code == 400


def test_habilitated_pj_gets_declaration_without_warning(client):
    files = {"proof": ("comprovante.pdf", b"%PDF-1.4 fake", "application/pdf")}
    assert client.put("/institution/status?status=habilitada", files=files).status_code == 200

    institution = client.get("/institution").json()
    assert institution["status"] == "habilitada"
    assert institution["has_proof"] is True

    response = client.post("/donations", json=PJ_DONATION).json()
    assert response["document_type"] == "Declaração de Doação Pós-Habilitação"
    assert response["warning_applied"] is False

    proof = client.get("/institution/proof")
    assert proof.status_code == 200
    assert proof.content == b"%PDF-1.4 fake"


def test_habilitated_pf_keeps_receipt_without_warning(client):
    files = {"proof": ("comprovante.pdf", b"%PDF-1.4 fake", "application/pdf")}
    client.put("/institution/status?status=habilitada", files=files)
    response = client.post("/donations", json=PF_DONATION).json()
    assert response["document_type"] == "Recibo de Doação PF"
    assert response["warning_applied"] is False


def test_disable_institution_removes_proof(client):
    files = {"proof": ("comprovante.pdf", b"%PDF-1.4 fake", "application/pdf")}
    client.put("/institution/status?status=habilitada", files=files)
    client.put("/institution/status?status=nao_habilitada")
    institution = client.get("/institution").json()
    assert institution["status"] == "nao_habilitada"
    assert institution["has_proof"] is False
    assert client.get("/institution/proof").status_code == 404


def test_void_and_restore(client, sample_donation):
    donation_id = sample_donation["id"]
    voided = client.delete(f"/donations/{donation_id}?reason=valor incorreto")
    assert voided.status_code == 200

    active = client.get("/donations?status=ativas").json()
    assert active == []
    cancelled = client.get("/donations?status=canceladas").json()
    assert len(cancelled) == 1
    assert cancelled[0]["voided"] is True
    assert "incorreto" in cancelled[0]["void_reason"]

    assert client.post(f"/donations/{donation_id}/restore").status_code == 200
    assert len(client.get("/donations?status=ativas").json()) == 1


def test_filters_by_period_and_type(client):
    client.post("/donations", json=PF_DONATION)
    client.post("/donations", json={**GOODS_DONATION, "received_at": "2026-10-01"})

    assert len(client.get("/donations?donation_type=bem").json()) == 1
    assert len(client.get("/donations?date_from=2026-11-01").json()) == 1
    assert len(client.get("/donations?date_to=2026-10-31").json()) == 1
    assert len(client.get("/donations?search=BR-2026").json()) == 2


def test_csv_export(client):
    client.post("/donations", json=PF_DONATION)
    response = client.get("/donations/export.csv")
    assert response.status_code == 200
    assert "text/csv" in response.headers["content-type"]
    assert response.content.startswith(b"\xef\xbb\xbf")
    text = response.content.decode("utf-8-sig")
    assert "Número;Data de recebimento;Doador" in text
    assert "BR-2026-000001" in text
    assert "1500,50" in text  # CSV usa decimal com vírgula e sem milhar (Excel pt-BR)


def test_stats(client):
    client.post("/donations", json=PF_DONATION)
    client.post("/donations", json=GOODS_DONATION)
    stats = client.get("/stats").json()
    assert stats["donations_count"] == 2
    assert stats["financial_count"] == 1
    assert stats["goods_count"] == 1
    assert stats["total_general"] == 1500.5 + 2400.0
    assert stats["donors_count"] == 2
    assert stats["total_general_formatted"].startswith("R$")
    assert stats["monthly"]


def test_donor_detail(client, sample_donation):
    donor_id = client.get("/donors").json()[0]["id"]
    detail = client.get(f"/donors/{donor_id}").json()
    assert detail["donations_count"] == 1
    assert detail["total_donated"] == 1500.5
    assert detail["donations"][0]["number"] == sample_donation["number"]
    assert detail["tax_id_formatted"] == "123.456.789-01"


def test_donation_detail_includes_words(client, sample_donation):
    detail = client.get(f"/donations/{sample_donation['id']}").json()
    assert "mil e quinhentos reais" in detail["amount_in_words"]


def test_missing_donation_returns_404(client):
    assert client.get("/donations/9999").status_code == 404
    assert client.get("/documents/9999/pdf").status_code == 404
    assert client.delete("/donations/9999").status_code == 404


# ---------------------------------------------------------------------------
# Identidade visual (logo e assinatura)
# ---------------------------------------------------------------------------
from tests.conftest import PNG_BYTES


def test_logo_upload_preview_and_removal(client):
    upload = client.put("/institution/logo", files={"logo": ("logo.png", PNG_BYTES, "image/png")})
    assert upload.status_code == 200
    assert upload.json()["has_logo"] is True
    assert upload.json()["logo_filename"] == "logo.png"

    image = client.get("/institution/logo")
    assert image.status_code == 200
    assert image.headers["content-type"] == "image/png"
    assert image.content == PNG_BYTES

    removed = client.delete("/institution/logo")
    assert removed.status_code == 200
    assert removed.json()["has_logo"] is False
    assert client.get("/institution/logo").status_code == 404


def test_signature_upload_and_removal(client):
    upload = client.put(
        "/institution/signature",
        files={"signature": ("assinatura.png", PNG_BYTES, "image/png")},
    )
    assert upload.status_code == 200
    assert upload.json()["has_signature"] is True
    assert client.get("/institution/signature").status_code == 200

    assert client.delete("/institution/signature").json()["has_signature"] is False
    assert client.get("/institution/signature").status_code == 404


def test_image_upload_rejects_invalid_file(client):
    invalid = client.put("/institution/logo", files={"logo": ("nota.txt", b"texto", "text/plain")})
    assert invalid.status_code == 400
    empty = client.put("/institution/logo", files={"logo": ("vazio.png", b"", "image/png")})
    assert empty.status_code == 400


def test_image_upload_rejects_oversized_file(client):
    oversized = b"\x89PNG\r\n\x1a\n" + b"0" * (1_500_001)
    response = client.put("/institution/logo", files={"logo": ("grande.png", oversized, "image/png")})
    assert response.status_code == 400


def test_signatory_data_is_saved(client):
    response = client.put(
        "/institution",
        json={"signatory_name": "Andrea Queiroz", "signatory_role": "Presidente voluntária"},
    )
    assert response.status_code == 200
    data = client.get("/institution").json()
    assert data["signatory_name"] == "Andrea Queiroz"
    assert data["signatory_role"] == "Presidente voluntária"


def test_pdf_includes_logo_and_signature_images(client, sample_donation):
    plain = client.get(f"/documents/{sample_donation['id']}/pdf").content

    client.put("/institution/logo", files={"logo": ("logo.png", PNG_BYTES, "image/png")})
    client.put("/institution/signature", files={"signature": ("sig.png", PNG_BYTES, "image/png")})
    branded = client.get(f"/documents/{sample_donation['id']}/pdf").content

    assert branded.startswith(b"%PDF")
    assert branded.count(b"/Subtype /Image") > plain.count(b"/Subtype /Image")
    assert len(branded) > len(plain)


def test_pdf_survives_special_characters(client):
    payload = {
        "person_type": "PJ",
        "donor_name": "Silva & Cia <Comércio> LTDA",
        "tax_id": "98.765.432/0001-10",
        "donation_type": "bem",
        "received_at": "2026-11-13",
        "purpose": "Doação de itens \"diversos\" & alimentos",
        "description": "Alimentos <não perecíveis> & água",
        "quantity": 5,
        "estimated_value": 300.0,
    }
    created = client.post("/donations", json=payload)
    assert created.status_code == 200
    pdf = client.get(f"/documents/{created.json()['id']}/pdf")
    assert pdf.status_code == 200
    assert pdf.content.startswith(b"%PDF")
