"""API do BemRecibo — controle de doações e emissão de recibos.

Todas as rotas da primeira versão foram preservadas (mesmos caminhos, mesmos
parâmetros, mesmas respostas) e novas rotas foram adicionadas ao lado delas.
"""
from __future__ import annotations

import base64
import csv
import io
import mimetypes
import os
from collections import defaultdict
from contextlib import asynccontextmanager
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Optional

from fastapi import Depends, FastAPI, File, HTTPException, Query, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import RedirectResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from sqlalchemy import func, or_
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, joinedload

from . import models, schemas
from .database import Base, SessionLocal, engine, get_db
from .services import brl, build_pdf, detect_image_type, format_tax_id, number_to_words_pt

BASE_DIR = Path(__file__).resolve().parents[1]
FRONTEND_DIR = BASE_DIR.parent / "frontend"

INSTITUTION_DEFAULTS = {
    "name": "Instituto Pelo Bem",
    "address": "Rua Pedro Henrique, 300 — Santo Amaro",
    "city": "Recife - PE",
}

DOCUMENT_PREFIX = "BR"
VALID_STATUSES = ("nao_habilitada", "habilitada")


@asynccontextmanager
async def lifespan(app: FastAPI):
    Base.metadata.create_all(bind=engine)
    try:
        from .database import apply_light_migrations

        apply_light_migrations()
    except Exception:  # banco novo já nasce completo; migração é best-effort
        pass
    db = SessionLocal()
    try:
        get_institution(db)
    finally:
        db.close()
    yield


app = FastAPI(
    title="BemRecibo API",
    version="1.1.0",
    description="MVP acadêmico para controle de doações e geração de recibos.",
    lifespan=lifespan,
)

_origins = os.getenv("ALLOWED_ORIGINS", "*")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"] if _origins.strip() == "*" else [o.strip() for o in _origins.split(",")],
    allow_credentials=False if _origins.strip() == "*" else True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ---------------------------------------------------------------------------
# Instituição
# ---------------------------------------------------------------------------


def get_institution(db: Session) -> models.Institution:
    institution = db.query(models.Institution).filter(models.Institution.id == 1).first()
    if not institution:
        institution = models.Institution(id=1, status="nao_habilitada", **INSTITUTION_DEFAULTS)
        db.add(institution)
        db.commit()
        db.refresh(institution)
    return institution


def _institution_payload(institution: models.Institution) -> dict:
    return {
        "name": institution.name,
        "status": institution.status,
        "cnpj": institution.cnpj,
        "address": institution.address,
        "city": institution.city,
        "phone": institution.phone,
        "email": institution.email,
        "site": institution.site,
        "signatory_name": institution.signatory_name,
        "signatory_role": institution.signatory_role,
        "has_logo": bool(institution.logo_content),
        "logo_filename": institution.logo_filename,
        "has_signature": bool(institution.signature_content),
        "signature_filename": institution.signature_filename,
        "has_proof": bool(institution.proof_content),
        "proof_filename": institution.proof_filename,
        "proof_uploaded_at": institution.proof_uploaded_at,
        "updated_at": institution.updated_at,
    }


@app.get("/institution", response_model=schemas.InstitutionOut)
def read_institution(db: Session = Depends(get_db)):
    return _institution_payload(get_institution(db))


@app.put("/institution")
def update_institution(payload: schemas.InstitutionUpdate, db: Session = Depends(get_db)):
    institution = get_institution(db)
    data = payload.model_dump(exclude_unset=True)
    for field, value in data.items():
        if value is not None:
            setattr(institution, field, value.strip() if isinstance(value, str) else value)
    institution.updated_at = datetime.now(timezone.utc)
    db.commit()
    return {"message": "Dados institucionais atualizados.", **_institution_payload(institution)}


@app.put("/institution/status")
async def update_institution_status(
    status: str,
    proof: UploadFile | None = File(default=None),
    db: Session = Depends(get_db),
):
    if status not in VALID_STATUSES:
        raise HTTPException(400, "Status inválido.")
    i = get_institution(db)
    if status == "habilitada":
        if proof is None:
            raise HTTPException(400, "Anexe o comprovante legal para habilitar a instituição.")
        content = await proof.read()
        if not content:
            raise HTTPException(400, "O comprovante está vazio.")
        i.proof_filename = proof.filename
        i.proof_content = base64.b64encode(content).decode("ascii")
        i.proof_uploaded_at = datetime.now(timezone.utc)
    else:
        i.proof_filename = None
        i.proof_content = None
        i.proof_uploaded_at = None
    i.status = status
    i.updated_at = datetime.now(timezone.utc)
    db.commit()
    return {"message": "Status atualizado.", "status": i.status, "has_proof": bool(i.proof_content)}


@app.get("/institution/proof")
def download_proof(db: Session = Depends(get_db)):
    institution = get_institution(db)
    if not institution.proof_content:
        raise HTTPException(404, "Nenhum comprovante anexado.")
    try:
        content = base64.b64decode(institution.proof_content)
    except Exception:
        raise HTTPException(500, "Comprovante armazenado em formato inválido.")
    filename = institution.proof_filename or "comprovante"
    media_type = mimetypes.guess_type(filename)[0] or "application/octet-stream"
    return StreamingResponse(
        io.BytesIO(content),
        media_type=media_type,
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


# ---------------------------------------------------------------------------
# Identidade visual (logo e assinatura usadas nos PDFs)
# ---------------------------------------------------------------------------

MAX_IMAGE_BYTES = 1_500_000  # 1,5 MB
IMAGE_FIELD_LABEL = {"logo": "logotipo", "signature": "assinatura"}


async def _read_image(upload: UploadFile, label: str) -> tuple[str, str]:
    """Valida e devolve (base64, nome do arquivo) de uma imagem PNG/JPEG."""
    content = await upload.read()
    if not content:
        raise HTTPException(400, f"O arquivo de {label} está vazio.")
    if len(content) > MAX_IMAGE_BYTES:
        raise HTTPException(400, f"O arquivo de {label} excede 1,5 MB.")
    if detect_image_type(content) is None:
        raise HTTPException(400, f"Formato inválido para {label}. Envie PNG ou JPEG.")
    return base64.b64encode(content).decode("ascii"), (upload.filename or f"{label}.png")


def _image_download(content_b64: str | None, filename: str | None, default_name: str):
    if not content_b64:
        raise HTTPException(404, "Imagem não cadastrada.")
    try:
        raw = base64.b64decode(content_b64)
    except Exception:
        raise HTTPException(500, "Imagem armazenada em formato inválido.")
    media_type = detect_image_type(raw) or "application/octet-stream"
    return StreamingResponse(
        io.BytesIO(raw),
        media_type=media_type,
        headers={
            "Content-Disposition": f'inline; filename="{filename or default_name}"',
            "Cache-Control": "no-store",
        },
    )


@app.put("/institution/logo")
async def update_logo(logo: UploadFile = File(...), db: Session = Depends(get_db)):
    content, filename = await _read_image(logo, "logotipo")
    institution = get_institution(db)
    institution.logo_content = content
    institution.logo_filename = filename
    institution.updated_at = datetime.now(timezone.utc)
    db.commit()
    return {"message": "Logotipo atualizado.", **_institution_payload(institution)}


@app.delete("/institution/logo")
def delete_logo(db: Session = Depends(get_db)):
    institution = get_institution(db)
    institution.logo_content = None
    institution.logo_filename = None
    institution.updated_at = datetime.now(timezone.utc)
    db.commit()
    return {"message": "Logotipo removido.", **_institution_payload(institution)}


@app.get("/institution/logo")
def get_logo(db: Session = Depends(get_db)):
    institution = get_institution(db)
    return _image_download(institution.logo_content, institution.logo_filename, "logo.png")


@app.put("/institution/signature")
async def update_signature(signature: UploadFile = File(...), db: Session = Depends(get_db)):
    content, filename = await _read_image(signature, "assinatura")
    institution = get_institution(db)
    institution.signature_content = content
    institution.signature_filename = filename
    institution.updated_at = datetime.now(timezone.utc)
    db.commit()
    return {"message": "Assinatura atualizada.", **_institution_payload(institution)}


@app.delete("/institution/signature")
def delete_signature(db: Session = Depends(get_db)):
    institution = get_institution(db)
    institution.signature_content = None
    institution.signature_filename = None
    institution.updated_at = datetime.now(timezone.utc)
    db.commit()
    return {"message": "Assinatura removida.", **_institution_payload(institution)}


@app.get("/institution/signature")
def get_signature(db: Session = Depends(get_db)):
    institution = get_institution(db)
    return _image_download(
        institution.signature_content, institution.signature_filename, "assinatura.png"
    )


# ---------------------------------------------------------------------------
# Doadores
# ---------------------------------------------------------------------------


@app.post("/donors", response_model=schemas.DonorOut)
def create_donor(payload: schemas.DonorCreate, db: Session = Depends(get_db)):
    existing = db.query(models.Donor).filter(models.Donor.tax_id == payload.tax_id).first()
    if existing:
        raise HTTPException(409, "Já existe um doador com esse CPF/CNPJ.")
    donor = models.Donor(**payload.model_dump())
    db.add(donor)
    db.commit()
    db.refresh(donor)
    return donor


@app.get("/donors", response_model=list[schemas.DonorOut])
def list_donors(
    search: str | None = None,
    person_type: Optional[str] = Query(default=None, pattern="^(PF|PJ)$"),
    db: Session = Depends(get_db),
):
    query = db.query(models.Donor)
    if search:
        term = f"%{search}%"
        query = query.filter(or_(models.Donor.name.ilike(term), models.Donor.tax_id.ilike(term)))
    if person_type:
        query = query.filter(models.Donor.person_type == person_type)
    return query.order_by(models.Donor.name).all()


@app.get("/donors/{donor_id}")
def donor_detail(donor_id: int, db: Session = Depends(get_db)):
    donor = db.query(models.Donor).filter(models.Donor.id == donor_id).first()
    if not donor:
        raise HTTPException(404, "Doador não encontrado.")
    donation_q = (
        db.query(models.Donation)
        .filter(models.Donation.donor_id == donor_id)
        .order_by(models.Donation.received_at.desc(), models.Donation.id.desc())
        .all()
    )
    active = [d for d in donation_q if not d.voided]
    total = sum((d.amount or d.estimated_value or 0) for d in active)
    return {
        "id": donor.id,
        "person_type": donor.person_type,
        "name": donor.name,
        "tax_id": donor.tax_id,
        "tax_id_formatted": format_tax_id(donor.tax_id, donor.person_type),
        "email": donor.email,
        "phone": donor.phone,
        "representative": donor.representative,
        "created_at": donor.created_at,
        "donations_count": len(active),
        "total_donated": round(total, 2),
        "total_donated_formatted": brl(total),
        "donations": [
            {
                "id": d.id,
                "number": d.number,
                "received_at": d.received_at.isoformat(),
                "donation_type": d.donation_type,
                "amount": d.amount if d.amount is not None else d.estimated_value,
                "document_type": d.document_type,
                "voided": bool(d.voided),
            }
            for d in donation_q
        ],
    }


# ---------------------------------------------------------------------------
# Doações
# ---------------------------------------------------------------------------


def _next_number(db: Session, year: int) -> str:
    last = (
        db.query(models.Donation)
        .filter(models.Donation.number.like(f"{DOCUMENT_PREFIX}-{year}-%"))
        .order_by(models.Donation.id.desc())
        .first()
    )
    next_number = 1
    if last:
        try:
            next_number = int(last.number.rsplit("-", 1)[1]) + 1
        except (IndexError, ValueError):
            next_number = 1
    return f"{DOCUMENT_PREFIX}-{year}-{next_number:06d}"


def _serialize_donation(donation: models.Donation) -> dict:
    donor = donation.donor
    return {
        "id": donation.id,
        "number": donation.number,
        "donor_id": donation.donor_id,
        "donor_name": donor.name if donor else "",
        "tax_id": donor.tax_id if donor else "",
        "tax_id_formatted": format_tax_id(donor.tax_id, donor.person_type) if donor else "",
        "person_type": donor.person_type if donor else "",
        "donation_type": donation.donation_type,
        "received_at": donation.received_at.isoformat(),
        "purpose": donation.purpose,
        "amount": donation.amount if donation.amount is not None else donation.estimated_value,
        "amount_formatted": brl(donation.amount if donation.amount is not None else donation.estimated_value),
        "description": donation.description,
        "quantity": donation.quantity,
        "payment_method": donation.payment_method,
        "document_type": donation.document_type,
        "institution_status_snapshot": donation.institution_status_snapshot,
        "warning_applied": bool(donation.warning_applied),
        "voided": bool(donation.voided),
        "void_reason": donation.void_reason,
        "created_at": donation.created_at.isoformat() if donation.created_at else None,
    }


@app.post("/donations")
def create_donation(payload: schemas.DonationCreate, db: Session = Depends(get_db)):
    institution = get_institution(db)
    if institution.status == "habilitada" and not institution.proof_content:
        raise HTTPException(409, "Habilitação sem comprovante. Operação bloqueada.")
    if institution.status == "habilitada" and payload.person_type == "PJ":
        document_type = "Declaração de Doação Pós-Habilitação"
        warning = False
    else:
        document_type = (
            "Recibo de Doação PF" if payload.person_type == "PF" else "Recibo de Doação PJ"
        )
        warning = institution.status != "habilitada"

    donor = db.query(models.Donor).filter(models.Donor.tax_id == payload.tax_id).first()
    if donor:
        if donor.person_type != payload.person_type:
            raise HTTPException(409, "O tipo de pessoa diverge do cadastro existente.")
        donor.name, donor.email, donor.phone = payload.donor_name, payload.email, payload.phone
        donor.representative = payload.representative or donor.representative
    else:
        donor = models.Donor(
            person_type=payload.person_type,
            name=payload.donor_name,
            tax_id=payload.tax_id,
            email=payload.email,
            phone=payload.phone,
            representative=payload.representative,
        )
        db.add(donor)
        db.flush()

    # Numeração sequencial por ano. Em caso de concorrência, tenta novamente com
    # o próximo número livre em vez de devolver erro para o operador.
    last_error: Exception | None = None
    for _ in range(5):
        donation = models.Donation(
            number=_next_number(db, payload.received_at.year),
            donor=donor,
            donation_type=payload.donation_type,
            received_at=payload.received_at,
            purpose=payload.purpose,
            payment_method=payload.payment_method,
            amount=payload.amount if payload.donation_type == "financeira" else None,
            description=payload.description,
            quantity=payload.quantity,
            estimated_value=payload.estimated_value,
            brand_model=payload.brand_model,
            fiscal_document=payload.fiscal_document,
            notes=payload.notes,
            document_type=(
                "Termo de Doação e Entrega" if payload.donation_type == "bem" else document_type
            ),
            institution_status_snapshot=institution.status,
            warning_applied=warning,
        )
        try:
            db.add(donation)
            db.flush()
            filename = f"{donation.number}.pdf"
            db.add(
                models.Document(
                    donation_id=donation.id,
                    document_type=donation.document_type,
                    filename=filename,
                )
            )
            db.commit()
            break
        except IntegrityError as exc:  # número já usado por outra requisição
            last_error = exc
            db.rollback()
            donor = db.query(models.Donor).filter(models.Donor.tax_id == payload.tax_id).first()
            if donor is None:
                raise HTTPException(409, "Não foi possível registrar o doador. Tente novamente.")
    else:
        raise HTTPException(409, f"Não foi possível gerar a numeração do documento: {last_error}")

    db.refresh(donation)
    return {
        "id": donation.id,
        "number": donation.number,
        "document_type": donation.document_type,
        "warning_applied": bool(donation.warning_applied),
        "pdf_url": f"/documents/{donation.id}/pdf",
        "message": "Doação registrada. Documento disponível para download.",
    }


def _filtered_donations_query(
    db: Session,
    search: str | None,
    date_from: date | None,
    date_to: date | None,
    donation_type: str | None,
    status: str | None,
):
    query = db.query(models.Donation).options(joinedload(models.Donation.donor)).join(models.Donor)
    if search:
        term = f"%{search}%"
        query = query.filter(
            or_(
                models.Donor.name.ilike(term),
                models.Donor.tax_id.ilike(term),
                models.Donation.number.ilike(term),
            )
        )
    if date_from:
        query = query.filter(models.Donation.received_at >= date_from)
    if date_to:
        query = query.filter(models.Donation.received_at <= date_to)
    if donation_type in ("financeira", "bem"):
        query = query.filter(models.Donation.donation_type == donation_type)
    if status == "ativas":
        query = query.filter(or_(models.Donation.voided.is_(False), models.Donation.voided.is_(None)))
    elif status == "canceladas":
        query = query.filter(models.Donation.voided.is_(True))
    return query


@app.get("/donations")
def list_donations(
    search: str | None = None,
    date_from: Optional[date] = None,
    date_to: Optional[date] = None,
    donation_type: Optional[str] = Query(default=None, pattern="^(financeira|bem)?$"),
    status: Optional[str] = Query(default=None, pattern="^(ativas|canceladas|todas)?$"),
    limit: Optional[int] = Query(default=None, ge=1, le=1000),
    offset: int = Query(default=0, ge=0),
    db: Session = Depends(get_db),
):
    query = _filtered_donations_query(db, search, date_from, date_to, donation_type, status)
    query = query.order_by(models.Donation.id.desc())
    if offset:
        query = query.offset(offset)
    if limit:
        query = query.limit(limit)
    return [_serialize_donation(d) for d in query.all()]


@app.get("/donations/export.csv")
def export_donations_csv(
    search: str | None = None,
    date_from: Optional[date] = None,
    date_to: Optional[date] = None,
    donation_type: Optional[str] = None,
    status: Optional[str] = None,
    db: Session = Depends(get_db),
):
    query = _filtered_donations_query(db, search, date_from, date_to, donation_type, status)
    donations = query.order_by(models.Donation.id.desc()).all()

    buffer = io.StringIO()
    writer = csv.writer(buffer, delimiter=";", lineterminator="\r\n")
    writer.writerow([
        "Número", "Data de recebimento", "Doador", "Tipo de doador", "CPF/CNPJ",
        "Modalidade", "Valor (R$)", "Finalidade", "Forma de recebimento",
        "Documento emitido", "Status institucional", "Cancelada", "Motivo do cancelamento",
    ])
    for d in donations:
        writer.writerow([
            d.number,
            d.received_at.strftime("%d/%m/%Y"),
            d.donor.name if d.donor else "",
            d.donor.person_type if d.donor else "",
            format_tax_id(d.donor.tax_id, d.donor.person_type) if d.donor else "",
            "Financeira" if d.donation_type == "financeira" else "Bem/Serviço",
            f"{(d.amount if d.amount is not None else (d.estimated_value or 0)):.2f}".replace(".", ","),
            d.purpose,
            d.payment_method or "",
            d.document_type,
            d.institution_status_snapshot,
            "Sim" if d.voided else "Não",
            d.void_reason or "",
        ])

    content = buffer.getvalue().encode("utf-8-sig")
    filename = f"bemrecibo-doacoes-{datetime.now(timezone.utc):%Y%m%d}.csv"
    return StreamingResponse(
        io.BytesIO(content),
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@app.get("/donations/{donation_id}")
def donation_detail(donation_id: int, db: Session = Depends(get_db)):
    donation = (
        db.query(models.Donation)
        .options(joinedload(models.Donation.donor))
        .filter(models.Donation.id == donation_id)
        .first()
    )
    if not donation:
        raise HTTPException(404, "Doação não encontrada.")
    data = _serialize_donation(donation)
    data.update({
        "email": donation.donor.email if donation.donor else None,
        "phone": donation.donor.phone if donation.donor else None,
        "representative": donation.donor.representative if donation.donor else None,
        "brand_model": donation.brand_model,
        "fiscal_document": donation.fiscal_document,
        "notes": donation.notes,
        "estimated_value": donation.estimated_value,
        "quantity": donation.quantity,
        "amount_in_words": number_to_words_pt(
            donation.amount if donation.amount is not None else donation.estimated_value
        ),
    })
    return data


@app.delete("/donations/{donation_id}")
def void_donation(
    donation_id: int,
    reason: Optional[str] = Query(default=None, max_length=250),
    db: Session = Depends(get_db),
):
    donation = db.query(models.Donation).filter(models.Donation.id == donation_id).first()
    if not donation:
        raise HTTPException(404, "Doação não encontrada.")
    if not donation.voided:
        donation.voided = True
        donation.void_reason = reason or "Cancelamento solicitado pela gestão"
        donation.voided_at = datetime.now(timezone.utc)
        db.commit()
    return {
        "message": "Doação cancelada. O registro permanece no histórico para auditoria.",
        "id": donation.id,
        "voided": True,
    }


@app.post("/donations/{donation_id}/restore")
def restore_donation(donation_id: int, db: Session = Depends(get_db)):
    donation = db.query(models.Donation).filter(models.Donation.id == donation_id).first()
    if not donation:
        raise HTTPException(404, "Doação não encontrada.")
    donation.voided = False
    donation.void_reason = None
    donation.voided_at = None
    db.commit()
    return {"message": "Doação reativada.", "id": donation.id, "voided": False}


# ---------------------------------------------------------------------------
# Indicadores
# ---------------------------------------------------------------------------


@app.get("/stats")
def stats(db: Session = Depends(get_db)):
    institution = get_institution(db)
    donations = db.query(models.Donation).options(joinedload(models.Donation.donor)).all()
    active = [d for d in donations if not d.voided]
    financial = [d for d in active if d.donation_type == "financeira"]
    goods = [d for d in active if d.donation_type == "bem"]

    total_financial = sum(d.amount or 0 for d in financial)
    total_goods = sum(d.estimated_value or 0 for d in goods)
    donors_count = db.query(func.count(models.Donor.id)).scalar() or 0

    monthly: dict[str, dict] = defaultdict(lambda: {"total": 0.0, "count": 0})
    for d in active:
        key = d.received_at.strftime("%Y-%m")
        monthly[key]["total"] += d.amount if d.amount is not None else (d.estimated_value or 0)
        monthly[key]["count"] += 1
    monthly_series = [
        {"month": key, "total": round(value["total"], 2), "count": value["count"]}
        for key, value in sorted(monthly.items())
    ]

    top_donors: dict[int, dict] = {}
    for d in active:
        if not d.donor:
            continue
        entry = top_donors.setdefault(
            d.donor.id,
            {
                "id": d.donor.id,
                "name": d.donor.name,
                "person_type": d.donor.person_type,
                "tax_id": format_tax_id(d.donor.tax_id, d.donor.person_type),
                "total": 0.0,
                "count": 0,
            },
        )
        entry["total"] += d.amount if d.amount is not None else (d.estimated_value or 0)
        entry["count"] += 1
    ranked = sorted(top_donors.values(), key=lambda item: item["total"], reverse=True)[:5]
    for item in ranked:
        item["total"] = round(item["total"], 2)
        item["total_formatted"] = brl(item["total"])

    recent = sorted(active, key=lambda d: (d.received_at, d.id), reverse=True)[:6]

    return {
        "institution_status": institution.status,
        "institution_name": institution.name,
        "donations_count": len(active),
        "cancelled_count": len([d for d in donations if d.voided]),
        "donors_count": donors_count,
        "financial_count": len(financial),
        "goods_count": len(goods),
        "total_financial": round(total_financial, 2),
        "total_goods": round(total_goods, 2),
        "total_general": round(total_financial + total_goods, 2),
        "total_financial_formatted": brl(total_financial),
        "total_goods_formatted": brl(total_goods),
        "total_general_formatted": brl(total_financial + total_goods),
        "average_ticket": round(total_financial / len(financial), 2) if financial else 0,
        "average_ticket_formatted": brl(total_financial / len(financial) if financial else 0),
        "monthly": monthly_series,
        "top_donors": ranked,
        "recent_donations": [_serialize_donation(d) for d in recent],
    }


# ---------------------------------------------------------------------------
# Documentos
# ---------------------------------------------------------------------------


@app.get("/documents/{donation_id}/pdf")
def download_document(
    donation_id: int,
    inline: bool = False,
    db: Session = Depends(get_db),
):
    donation = (
        db.query(models.Donation)
        .options(joinedload(models.Donation.donor))
        .filter(models.Donation.id == donation_id)
        .first()
    )
    if not donation:
        raise HTTPException(404, "Doação não encontrada.")
    pdf = build_pdf(donation, donation.donor, get_institution(db))
    filename = f"{donation.number}.pdf"
    disposition = "inline" if inline else "attachment"
    return StreamingResponse(
        pdf,
        media_type="application/pdf",
        headers={"Content-Disposition": f'{disposition}; filename="{filename}"'},
    )


@app.get("/health")
def health():
    return {"status": "ok", "version": app.version}


@app.get("/")
def root(request: Request):
    # Navegador recebe a interface; clientes de API continuam recebendo o JSON.
    if "text/html" in request.headers.get("accept", ""):
        return RedirectResponse(url="/app/")
    return {"app": "BemRecibo", "status": "online", "docs": "/docs"}


if FRONTEND_DIR.is_dir():
    app.mount("/app", StaticFiles(directory=str(FRONTEND_DIR), html=True), name="frontend")
