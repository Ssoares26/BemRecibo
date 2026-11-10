from datetime import date, datetime

import pytest

from bemrecibo.services import (
    brl,
    build_pdf,
    format_tax_id,
    integer_to_words,
    number_to_words_pt,
)


@pytest.mark.parametrize(
    "value,expected",
    [
        (0, "zero real"),
        (1, "um real"),
        (1.01, "um real e um centavo"),
        (15, "quinze reais"),
        (100, "cem reais"),
        (101, "cento e um reais"),
        (1500, "mil e quinhentos reais"),
        (1234.50, "mil duzentos e trinta e quatro reais e cinquenta centavos"),
        (100000, "cem mil reais"),
        (1000000, "um milhão de reais"),
        (2000000, "dois milhões de reais"),
        (0.99, "noventa e nove centavos"),
    ],
)
def test_number_to_words_pt(value, expected):
    assert number_to_words_pt(value) == expected


def test_integer_to_words_scales():
    assert integer_to_words(0) == "zero"
    assert integer_to_words(999) == "novecentos e noventa e nove"
    assert integer_to_words(1000) == "mil"
    assert integer_to_words(1234567) == (
        "um milhão, duzentos e trinta e quatro mil, quinhentos e sessenta e sete"
    )


def test_number_to_words_rejects_negative():
    with pytest.raises(ValueError):
        number_to_words_pt(-1)


def test_brl_formatting():
    assert brl(1234.5) == "R$ 1.234,50"
    assert brl(0) == "R$ 0,00"
    assert brl(None) == "R$ 0,00"
    assert brl(1234567.891) == "R$ 1.234.567,89"


def test_tax_id_mask():
    assert format_tax_id("12345678901") == "123.456.789-01"
    assert format_tax_id("12345678000190") == "12.345.678/0001-90"
    assert format_tax_id("12.345.678/0001-90") == "12.345.678/0001-90"
    assert format_tax_id("") == ""


class FakeDonation:
    number = "BR-2026-000001"
    id = 1
    document_type = "Recibo de Doação PF"
    donation_type = "financeira"
    received_at = date(2026, 11, 10)
    purpose = "Apoio às atividades assistenciais"
    payment_method = "PIX"
    amount = 1500.5
    description = None
    quantity = None
    estimated_value = None
    brand_model = None
    fiscal_document = None
    notes = None
    warning_applied = True
    voided = False
    institution_status_snapshot = "nao_habilitada"
    created_at = datetime(2026, 11, 10, 12, 0, 0)


class FakeDonor:
    person_type = "PF"
    name = "Maria de Souza Lima"
    tax_id = "123.456.789-01"
    representative = None
    email = "maria@example.com"
    phone = None


def test_build_pdf_returns_pdf_bytes():
    pdf = build_pdf(FakeDonation(), FakeDonor(), "Instituto Pelo Bem")
    content = pdf.read()
    assert content.startswith(b"%PDF")
    assert len(content) > 1500


def test_build_pdf_accepts_institution_name_string():
    pdf = build_pdf(FakeDonation(), FakeDonor(), "Instituto Pelo Bem")
    assert pdf.read(4) == b"%PDF"
