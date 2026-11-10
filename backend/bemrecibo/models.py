from datetime import datetime, timezone

from sqlalchemy import (
    Boolean,
    Column,
    Date,
    DateTime,
    Float,
    ForeignKey,
    Integer,
    String,
    Text,
)
from sqlalchemy.orm import relationship

from .database import Base


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


class Institution(Base):
    __tablename__ = "institution"
    id = Column(Integer, primary_key=True, default=1)
    name = Column(String(180), nullable=False, default="Instituto Pelo Bem")
    status = Column(String(30), nullable=False, default="nao_habilitada")
    cnpj = Column(String(20), nullable=True)
    address = Column(String(200), nullable=True)
    city = Column(String(120), nullable=True)
    phone = Column(String(40), nullable=True)
    email = Column(String(180), nullable=True)
    site = Column(String(180), nullable=True)
    logo_filename = Column(String(255), nullable=True)
    logo_content = Column(Text, nullable=True)       # MVP: conteúdo em base64
    signature_filename = Column(String(255), nullable=True)
    signature_content = Column(Text, nullable=True)  # MVP: conteúdo em base64
    signatory_name = Column(String(180), nullable=True)
    signatory_role = Column(String(120), nullable=True)
    proof_filename = Column(String(255), nullable=True)
    proof_content = Column(Text, nullable=True)  # MVP: conteúdo codificado em base64
    proof_uploaded_at = Column(DateTime, nullable=True)
    updated_at = Column(DateTime, default=utcnow, onupdate=utcnow)


class Donor(Base):
    __tablename__ = "donors"
    id = Column(Integer, primary_key=True, index=True)
    person_type = Column(String(2), nullable=False)
    name = Column(String(180), nullable=False)
    tax_id = Column(String(30), nullable=False, unique=True, index=True)
    email = Column(String(180))
    phone = Column(String(40))
    representative = Column(String(180))
    created_at = Column(DateTime, default=utcnow)
    donations = relationship("Donation", back_populates="donor")


class Donation(Base):
    __tablename__ = "donations"
    id = Column(Integer, primary_key=True, index=True)
    number = Column(String(30), nullable=False, unique=True, index=True)
    donor_id = Column(Integer, ForeignKey("donors.id"), nullable=False)
    donation_type = Column(String(20), nullable=False)
    received_at = Column(Date, nullable=False)
    purpose = Column(String(250), nullable=False)
    payment_method = Column(String(100))
    amount = Column(Float)
    description = Column(Text)
    quantity = Column(Integer)
    estimated_value = Column(Float)
    brand_model = Column(String(160))
    fiscal_document = Column(String(100))
    notes = Column(Text)
    document_type = Column(String(60), nullable=False)
    institution_status_snapshot = Column(String(30), nullable=False)
    warning_applied = Column(Boolean, default=True)
    voided = Column(Boolean, default=False, nullable=False, server_default="0")
    void_reason = Column(String(250))
    voided_at = Column(DateTime)
    created_at = Column(DateTime, default=utcnow)
    donor = relationship("Donor", back_populates="donations")
    documents = relationship("Document", back_populates="donation", cascade="all, delete-orphan")


class Document(Base):
    __tablename__ = "documents"
    id = Column(Integer, primary_key=True, index=True)
    donation_id = Column(Integer, ForeignKey("donations.id"), nullable=False)
    document_type = Column(String(60), nullable=False)
    filename = Column(String(255), nullable=False)
    created_at = Column(DateTime, default=utcnow)
    donation = relationship("Donation", back_populates="documents")
