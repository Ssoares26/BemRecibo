"""Regras de formatação e geração dos documentos em PDF do BemRecibo."""
from __future__ import annotations

import base64
import hashlib
from datetime import date, datetime, timezone
from decimal import ROUND_HALF_UP, Decimal
from io import BytesIO
from typing import Iterable

from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER, TA_JUSTIFY
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.lib.utils import ImageReader
from reportlab.platypus import (
    Image,
    KeepTogether,
    Paragraph,
    SimpleDocTemplate,
    Spacer,
    Table,
    TableStyle,
)
from reportlab.platypus.flowables import HRFlowable
from xml.sax.saxutils import escape as esc

GREEN = colors.HexColor("#173c25")
GREEN_SOFT = colors.HexColor("#eef4ee")
LINE = colors.HexColor("#d7e0d7")
ORANGE = colors.HexColor("#8a4b16")

WARNING = (
    "ADVERTÊNCIA: no cenário de pré-habilitação, esta doação não é dedutível do "
    "Imposto sobre a Renda da Pessoa Jurídica (IRPJ). Texto demonstrativo sujeito "
    "à validação contábil e jurídica."
)

VOID_NOTICE = (
    "DOCUMENTO CANCELADO — este registro foi anulado no sistema e não possui "
    "validade para fins de comprovação de doação."
)

# ---------------------------------------------------------------------------
# Formatação
# ---------------------------------------------------------------------------


def brl(value) -> str:
    """Formata um número como moeda brasileira: 1234.5 -> 'R$ 1.234,50'."""
    quantum = Decimal("0.01")
    amount = Decimal(str(value or 0)).quantize(quantum, rounding=ROUND_HALF_UP)
    formatted = f"{amount:,.2f}".replace(",", "\u00a7").replace(".", ",").replace("\u00a7", ".")
    return f"R$ {formatted}"


def format_tax_id(value: str | None, person_type: str | None = None) -> str:
    """Aplica máscara de CPF/CNPJ quando o valor é composto apenas por dígitos."""
    digits = "".join(ch for ch in str(value or "") if ch.isdigit())
    if not digits:
        return value or ""
    if len(digits) == 11:
        return f"{digits[:3]}.{digits[3:6]}.{digits[6:9]}-{digits[9:]}"
    if len(digits) == 14:
        return f"{digits[:2]}.{digits[2:5]}.{digits[5:8]}/{digits[8:12]}-{digits[12:]}"
    return value or ""


def format_date_br(value: date | datetime | None) -> str:
    if not value:
        return "—"
    if isinstance(value, datetime):
        value = value.date()
    return value.strftime("%d/%m/%Y")


def capitalize_first(text: str) -> str:
    """'mil e quinhentos reais' -> 'Mil e quinhentos reais'."""
    return text[:1].upper() + text[1:] if text else text


def value_in_words(value) -> str:
    return capitalize_first(number_to_words_pt(value))


STATUS_LABELS = {
    "habilitada": "Instituição habilitada",
    "nao_habilitada": "Pré-habilitação",
}


def verification_code(donation) -> str:
    """Código curto e estável para conferência do documento impresso."""
    seed = f"{donation.number}|{donation.id}|{donation.received_at}|{donation.created_at}"
    digest = hashlib.sha256(seed.encode("utf-8")).hexdigest().upper()[:12]
    return f"{digest[:4]}-{digest[4:8]}-{digest[8:12]}"


# ---------------------------------------------------------------------------
# Valor por extenso (pt-BR)
# ---------------------------------------------------------------------------

_UNITS = ["zero", "um", "dois", "três", "quatro", "cinco", "seis", "sete", "oito", "nove"]
_TEENS = [
    "dez", "onze", "doze", "treze", "catorze", "quinze",
    "dezesseis", "dezessete", "dezoito", "dezenove",
]
_TENS = [
    "", "", "vinte", "trinta", "quarenta", "cinquenta",
    "sessenta", "setenta", "oitenta", "noventa",
]
_HUNDREDS = [
    "", "cento", "duzentos", "trezentos", "quatrocentos", "quinhentos",
    "seiscentos", "setecentos", "oitocentos", "novecentos",
]
_SCALES = [
    (10**9, "bilhão", "bilhões"),
    (10**6, "milhão", "milhões"),
]


def _below_100(number: int) -> str:
    if number < 10:
        return _UNITS[number]
    if number < 20:
        return _TEENS[number - 10]
    tens, units = divmod(number, 10)
    return _TENS[tens] + (" e " + _UNITS[units] if units else "")


def _below_1000(number: int) -> str:
    if number == 0:
        return ""
    if number == 100:
        return "cem"
    hundreds, rest = divmod(number, 100)
    parts = []
    if hundreds:
        parts.append(_HUNDREDS[hundreds])
    if rest:
        parts.append(_below_100(rest))
    return " e ".join(parts)


def _join_parts(groups: list[tuple[str, int]]) -> str:
    """Junta os grupos numéricos respeitando a concordância do português.

    O conectivo "e" aparece antes do último grupo quando ele é menor que 100
    ou múltiplo exato de 100 (ex.: 'mil e quinhentos'); caso contrário usa-se
    vírgula (ex.: 'mil, duzentos e trinta e quatro').
    """
    if not groups:
        return "zero"
    if len(groups) == 1:
        return groups[0][0]

    last_text, last_value = groups[-1]
    use_and = last_value < 100 or last_value % 100 == 0
    previous = [text for text, _ in groups[:-1]]

    if len(groups) == 2:
        # Dois grupos: 'mil duzentos e trinta e quatro' ou 'mil e quinhentos'.
        if use_and:
            return f"{previous[0]} e {last_text}"
        return f"{previous[0]} {last_text}"

    separator = " e " if use_and else ", "
    return ", ".join(previous) + separator + last_text


def integer_to_words(number: int) -> str:
    """Converte inteiros em palavras: 1500 -> 'mil e quinhentos'."""
    number = int(number)
    if number < 0:
        raise ValueError("Valor negativo não pode ser escrito por extenso.")
    if number == 0:
        return "zero"

    groups: list[tuple[str, int]] = []
    remaining = number

    for scale_value, singular, plural in _SCALES:
        if remaining >= scale_value:
            quantity, remaining = divmod(remaining, scale_value)
            groups.append((f"{_below_1000(quantity)} {singular if quantity == 1 else plural}", quantity * scale_value))

    if remaining >= 1000:
        quantity, remaining = divmod(remaining, 1000)
        text = "mil" if quantity == 1 else f"{_below_1000(quantity)} mil"
        groups.append((text, quantity * 1000))

    if remaining > 0:
        groups.append((_below_1000(remaining), remaining))

    return _join_parts(groups)


def number_to_words_pt(value) -> str:
    """Escreve um valor monetário por extenso.

    1234.50 -> 'mil duzentos e trinta e quatro reais e cinquenta centavos'
    """
    amount = Decimal(str(value or 0)).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
    if amount < 0:
        raise ValueError("Valor negativo não pode ser escrito por extenso.")

    reais = int(amount)
    centavos = int((amount - reais) * 100)

    def _currency(words: str, singular: str, plural: str) -> str:
        # 'um milhão de reais', 'dois milhões de reais', mas 'mil reais'.
        if words.split()[-1] in {"milhão", "milhões", "bilhão", "bilhões"}:
            return f"{words} de {plural}"
        return f"{words} {singular if words == 'um' else plural}"

    chunks: list[str] = []
    if reais:
        chunks.append(_currency(integer_to_words(reais), "real", "reais"))
    if centavos:
        chunks.append(_currency(integer_to_words(centavos), "centavo", "centavos"))
    if not chunks:
        return "zero real"
    return " e ".join(chunks)


# ---------------------------------------------------------------------------
# Imagens institucionais (logo e assinatura)
# ---------------------------------------------------------------------------

PNG_MAGIC = b"\x89PNG\r\n\x1a\n"
JPEG_MAGIC = b"\xff\xd8\xff"


def detect_image_type(content: bytes) -> str | None:
    """Retorna o MIME type da imagem ou None quando não é PNG/JPEG."""
    if content.startswith(PNG_MAGIC):
        return "image/png"
    if content.startswith(JPEG_MAGIC):
        return "image/jpeg"
    return None


def _image_flowable(content_b64: str | None, max_width, max_height):
    """Monta um flowable de imagem preservando a proporção original."""
    if not content_b64:
        return None
    try:
        raw = base64.b64decode(content_b64)
        reader = ImageReader(BytesIO(raw))
        width, height = reader.getSize()
        if not width or not height:
            return None
        scale = min(max_width / width, max_height / height)
        return Image(BytesIO(raw), width=width * scale, height=height * scale, mask="auto")
    except Exception:
        return None


# ---------------------------------------------------------------------------
# Documento PDF
# ---------------------------------------------------------------------------

GREEN_RULE = colors.HexColor("#173c25")


def _institution_attributes(institution) -> dict:
    """Aceita tanto o modelo Institution quanto um nome simples (compatibilidade)."""
    if isinstance(institution, str):
        return {"name": institution}
    keys = (
        "name", "cnpj", "address", "city", "phone", "email", "site", "status",
        "logo_content", "signature_content", "signatory_name", "signatory_role",
    )
    return {key: getattr(institution, key, None) for key in keys}


def _footer_factory(document_number: str, voided: bool):
    def _footer(canvas, doc):
        canvas.saveState()
        width, _ = A4
        canvas.setStrokeColor(LINE)
        canvas.setLineWidth(0.6)
        canvas.line(22 * mm, 18 * mm, width - 22 * mm, 18 * mm)
        canvas.setFont("Helvetica", 7.5)
        canvas.setFillColor(colors.HexColor("#68756c"))
        canvas.drawString(22 * mm, 13 * mm, f"BemRecibo · Documento {document_number} · via do sistema")
        if voided:
            canvas.setFillColor(colors.HexColor("#a33a2a"))
            canvas.drawString(22 * mm, 9.5 * mm, "DOCUMENTO CANCELADO")
        stamp = datetime.now(timezone.utc).strftime("%d/%m/%Y %H:%M UTC")
        canvas.drawRightString(width - 22 * mm, 13 * mm, f"Emitido em {stamp}")
        canvas.drawRightString(width - 22 * mm, 9.5 * mm, f"Página {canvas.getPageNumber()}")
        canvas.restoreState()

    return _footer


def build_pdf(donation, donor, institution):
    """Gera o PDF do recibo/termo da doação e devolve um BytesIO posicionado no início."""
    institution_data = _institution_attributes(institution)
    institution_name = esc(institution_data.get("name") or "Instituto Pelo Bem")

    buffer = BytesIO()
    doc = SimpleDocTemplate(
        buffer,
        pagesize=A4,
        rightMargin=20 * mm,
        leftMargin=20 * mm,
        topMargin=14 * mm,
        bottomMargin=22 * mm,
        title=f"{donation.document_type} {donation.number}",
        author=institution_data.get("name") or "Instituto Pelo Bem",
        subject="Recibo de doação",
    )

    base = getSampleStyleSheet()
    small = ParagraphStyle(
        "Small", parent=base["BodyText"], fontSize=8.6, leading=12.5,
        textColor=colors.HexColor("#3d4a41"),
    )
    body = ParagraphStyle("Body", parent=small, alignment=TA_JUSTIFY, fontSize=9.2, leading=14)
    cell = ParagraphStyle("Cell", parent=base["Normal"], fontSize=8.7, leading=11.4, wordWrap="CJK")
    cell_label = ParagraphStyle("CellLabel", parent=cell, fontName="Helvetica-Bold", textColor=GREEN)
    section = ParagraphStyle(
        "Section", parent=base["Normal"], fontName="Helvetica-Bold", fontSize=9.5,
        textColor=GREEN, spaceBefore=3, spaceAfter=2,
    )
    doc_kind = ParagraphStyle(
        "DocKind", parent=base["Heading2"], alignment=TA_CENTER,
        fontSize=12.5, leading=16, textColor=GREEN, spaceBefore=3, spaceAfter=2,
    )
    number_style = ParagraphStyle(
        "Number", parent=base["Normal"], alignment=TA_CENTER,
        fontSize=10, leading=13, textColor=colors.HexColor("#68756c"),
    )
    warning_style = ParagraphStyle(
        "Warning", parent=small, fontSize=8.2, leading=11.8, textColor=ORANGE,
        borderColor=colors.HexColor("#e9c28b"), borderWidth=0.7, borderPadding=6,
        backColor=colors.HexColor("#fff8ed"),
    )
    inst_name_style = ParagraphStyle(
        "InstName", parent=base["Normal"], fontName="Helvetica-Bold", fontSize=13.5,
        leading=16, textColor=GREEN,
    )
    identity_style = ParagraphStyle(
        "Identity", parent=base["Normal"], fontSize=8, leading=11,
        textColor=colors.HexColor("#5c6a61"),
    )

    story: list = []

    # ---------------------------------------------------------- cabeçalho --
    identity_lines = [
        format_tax_id(institution_data.get("cnpj")) if institution_data.get("cnpj") else "",
        institution_data.get("address") or "",
        institution_data.get("city") or "",
        " · ".join(filter(None, [
            institution_data.get("phone"),
            institution_data.get("email"),
            institution_data.get("site"),
        ])),
    ]
    identity_html = "<br/>".join(esc(line) for line in identity_lines if line)

    logo = _image_flowable(institution_data.get("logo_content"), 30 * mm, 15 * mm)
    name_block = [Paragraph(institution_name, inst_name_style)]
    if identity_html:
        name_block.append(Paragraph(identity_html, identity_style))

    if logo is not None:
        header = Table(
            [[logo, name_block]],
            colWidths=[34 * mm, 136 * mm],
        )
        header.setStyle(TableStyle([
            ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
            ("ALIGN", (0, 0), (0, 0), "LEFT"),
            ("LEFTPADDING", (0, 0), (-1, -1), 0),
            ("RIGHTPADDING", (0, 0), (0, 0), 6),
            ("RIGHTPADDING", (1, 0), (1, 0), 0),
            ("TOPPADDING", (0, 0), (-1, -1), 0),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 3),
        ]))
    else:
        header = Table([[name_block]], colWidths=[170 * mm])
        header.setStyle(TableStyle([
            ("LEFTPADDING", (0, 0), (-1, -1), 0),
            ("RIGHTPADDING", (0, 0), (-1, -1), 0),
            ("TOPPADDING", (0, 0), (-1, -1), 0),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 3),
        ]))

    story += [
        header,
        HRFlowable(width="100%", thickness=1.4, color=GREEN_RULE, spaceBefore=2, spaceAfter=6),
        Paragraph(esc(donation.document_type.upper()), doc_kind),
        Paragraph(f"Nº {esc(donation.number)}", number_style),
        Spacer(1, 6),
    ]

    if getattr(donation, "voided", False):
        story.append(Paragraph(VOID_NOTICE, ParagraphStyle(
            "Void", parent=warning_style, textColor=colors.HexColor("#a33a2a"),
            borderColor=colors.HexColor("#e3b3aa"), backColor=colors.HexColor("#fdf1ef"),
        )))
        story.append(Spacer(1, 8))

    # ------------------------------------------------------------- corpo ---
    donor_type = "Pessoa Física" if donor.person_type == "PF" else "Pessoa Jurídica"
    intro = (
        f"A instituição <b>{institution_name}</b> declara, para os devidos fins, que recebeu a "
        f"doação abaixo descrita de <b>{esc(donor.name)}</b>, inscrito(a) no CPF/CNPJ sob o nº "
        f"<b>{esc(format_tax_id(donor.tax_id, donor.person_type))}</b>, na data de "
        f"<b>{format_date_br(donation.received_at)}</b>."
    )
    story += [Paragraph(intro, body), Spacer(1, 10)]

    # (rótulo, valor, negrito)
    rows: list[tuple[str, str, bool]] = [
        ("Doador", donor.name, False),
        ("Tipo de doador", donor_type, False),
        ("CPF/CNPJ", format_tax_id(donor.tax_id, donor.person_type), False),
    ]
    if donor.representative:
        rows.append(("Representante legal", donor.representative, False))
    if donor.email or donor.phone:
        rows.append(("Contato", " · ".join(filter(None, [donor.email, donor.phone])), False))

    rows += [
        ("Data de recebimento", format_date_br(donation.received_at), False),
        ("Finalidade da doação", donation.purpose, False),
        ("Forma de recebimento", donation.payment_method or "Não informada", False),
    ]

    if donation.donation_type == "financeira":
        rows += [
            ("Modalidade", "Doação financeira", False),
            ("Valor da doação", brl(donation.amount), True),
            ("Valor por extenso", value_in_words(donation.amount), False),
        ]
    else:
        rows += [
            ("Modalidade", "Doação de bem ou serviço", False),
            ("Descrição do bem/serviço", donation.description or "", False),
            ("Quantidade", str(donation.quantity or ""), False),
            ("Marca / modelo", donation.brand_model or "Não informado", False),
            ("Documento fiscal", donation.fiscal_document or "Não informado", False),
            ("Valor de mercado estimado", brl(donation.estimated_value), True),
            ("Valor por extenso", value_in_words(donation.estimated_value), False),
        ]

    if donation.notes:
        rows.append(("Observações", donation.notes, False))

    table_data = [
        [
            Paragraph(esc(label), cell_label),
            Paragraph(f"<b>{esc(value)}</b>" if bold else esc(value), cell),
        ]
        for label, value, bold in rows
    ]
    table = Table(table_data, colWidths=[48 * mm, 122 * mm])
    table.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (0, -1), GREEN_SOFT),
        ("GRID", (0, 0), (-1, -1), 0.4, LINE),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING", (0, 0), (-1, -1), 7),
        ("RIGHTPADDING", (0, 0), (-1, -1), 7),
        ("TOPPADDING", (0, 0), (-1, -1), 3.5),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 3.5),
        ("ROWBACKGROUNDS", (1, 0), (1, -1), [colors.white, colors.HexColor("#fbfcfb")]),
    ]))
    story += [table, Spacer(1, 8)]

    if donation.donation_type == "bem":
        story += [
            Paragraph("Termo de doação e entrega", section),
            Paragraph(
                "O doador transfere à instituição, de forma gratuita e definitiva, a propriedade dos "
                "bens e serviços identificados neste termo, que declara recebê-los em bom estado de "
                "conservação e destiná-los exclusivamente às suas atividades assistenciais.",
                body,
            ),
            Spacer(1, 4),
        ]

    if donation.warning_applied:
        story += [Paragraph(WARNING, warning_style), Spacer(1, 8)]
    else:
        story.append(Spacer(1, 6))

    # ------------------------------------------------------- autenticidade --
    authenticity = Table(
        [[
            Paragraph("<b>Autenticidade</b>", cell_label),
            Paragraph(
                f"Código de verificação <b>{verification_code(donation)}</b> · "
                f"Registro {esc(donation.number)} · emitido em "
                f"{datetime.now(timezone.utc):%d/%m/%Y} pelo sistema BemRecibo. "
                "Confira o código com a instituição antes de aceitar este documento.",
                cell,
            ),
        ]],
        colWidths=[30 * mm, 140 * mm],
    )
    authenticity.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), colors.HexColor("#f7f9f7")),
        ("BOX", (0, 0), (-1, -1), 0.4, LINE),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("LEFTPADDING", (0, 0), (-1, -1), 7),
        ("RIGHTPADDING", (0, 0), (-1, -1), 7),
        ("TOPPADDING", (0, 0), (-1, -1), 5),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
    ]))
    story += [Spacer(1, 2), authenticity]

    # ---------------------------------------------------------- assinaturas --
    signature_image = _image_flowable(institution_data.get("signature_content"), 42 * mm, 16 * mm)

    institution_caption = "Responsável pela instituição"
    if institution_data.get("signatory_name"):
        institution_caption += f"<br/><b>{esc(institution_data['signatory_name'])}</b>"
    if institution_data.get("signatory_role"):
        institution_caption += f"<br/>{esc(institution_data['signatory_role'])}"

    # Uma única tabela de 3 linhas garante que as linhas de assinatura fiquem
    # exatamente na mesma altura, com ou sem imagem de assinatura.
    signature_table = Table(
        [
            [signature_image or "", ""],
            [Paragraph("__________________________________", cell),
             Paragraph("__________________________________", cell)],
            [Paragraph(institution_caption, cell), Paragraph("Doador / representante", cell)],
        ],
        colWidths=[85 * mm, 85 * mm],
    )
    signature_table.setStyle(TableStyle([
        ("ALIGN", (0, 0), (0, 0), "CENTER"),
        ("VALIGN", (0, 0), (-1, 0), "BOTTOM"),
        ("VALIGN", (0, 1), (-1, -1), "TOP"),
        ("ALIGN", (0, 1), (-1, -1), "CENTER"),
        ("LEFTPADDING", (0, 0), (-1, -1), 0),
        ("RIGHTPADDING", (0, 0), (-1, -1), 0),
        ("TOPPADDING", (0, 0), (-1, -1), 1),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 1),
    ]))

    story += [
        KeepTogether([
            Spacer(1, 10),
            signature_table,
            Spacer(1, 10),
            Paragraph(
                f"Documento gerado pelo BemRecibo · Registro interno {esc(donation.number)} · "
                f"Status institucional no momento da emissão: "
                f"{STATUS_LABELS.get(donation.institution_status_snapshot, 'Pré-habilitação')}. "
                "Modelo demonstrativo sujeito à validação institucional, contábil e jurídica.",
                ParagraphStyle("Foot", parent=small, fontSize=7.4, leading=10,
                               textColor=colors.HexColor("#78847b")),
            ),
        ])
    ]

    footer = _footer_factory(donation.number, bool(getattr(donation, "voided", False)))
    doc.build(story, onFirstPage=footer, onLaterPages=footer)
    buffer.seek(0)
    return buffer
