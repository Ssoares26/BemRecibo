from datetime import date, datetime
from typing import Literal, Optional

from pydantic import BaseModel, ConfigDict, Field, model_validator


class DonorCreate(BaseModel):
    person_type: Literal["PF", "PJ"]
    name: str = Field(min_length=2, max_length=180)
    tax_id: str = Field(min_length=5, max_length=30)
    email: Optional[str] = None
    phone: Optional[str] = None
    representative: Optional[str] = None


class DonorOut(BaseModel):
    id: int
    person_type: str
    name: str
    tax_id: str
    email: Optional[str] = None
    phone: Optional[str] = None
    representative: Optional[str] = None

    model_config = ConfigDict(from_attributes=True)


class DonationCreate(BaseModel):
    person_type: Literal["PF", "PJ"]
    donor_name: str = Field(min_length=2, max_length=180)
    tax_id: str = Field(min_length=5, max_length=30)
    email: Optional[str] = None
    phone: Optional[str] = None
    representative: Optional[str] = None
    donation_type: Literal["financeira", "bem"]
    received_at: date
    purpose: str = Field(min_length=2, max_length=250)
    payment_method: Optional[str] = None
    amount: Optional[float] = Field(default=None, gt=0)
    description: Optional[str] = None
    quantity: Optional[int] = Field(default=None, gt=0)
    estimated_value: Optional[float] = Field(default=None, gt=0)
    brand_model: Optional[str] = None
    fiscal_document: Optional[str] = None
    notes: Optional[str] = None

    @model_validator(mode="after")
    def validate_donation(self):
        if self.donation_type == "financeira" and self.amount is None:
            raise ValueError("Doação financeira exige valor.")
        if self.donation_type == "bem":
            if not self.description or self.quantity is None or self.estimated_value is None:
                raise ValueError(
                    "Doação de bem/serviço exige descrição, quantidade e valor estimado."
                )
        return self


class DonationOut(BaseModel):
    id: int
    number: str
    donor_name: str
    tax_id: str
    donation_type: str
    received_at: date
    amount: Optional[float]
    document_type: str

    model_config = ConfigDict(from_attributes=True)


class InstitutionUpdate(BaseModel):
    """Dados cadastrais da instituição usados no cabeçalho dos documentos."""

    name: Optional[str] = Field(default=None, min_length=2, max_length=180)
    cnpj: Optional[str] = Field(default=None, max_length=20)
    address: Optional[str] = Field(default=None, max_length=200)
    city: Optional[str] = Field(default=None, max_length=120)
    phone: Optional[str] = Field(default=None, max_length=40)
    email: Optional[str] = Field(default=None, max_length=180)
    site: Optional[str] = Field(default=None, max_length=180)
    signatory_name: Optional[str] = Field(default=None, max_length=180)
    signatory_role: Optional[str] = Field(default=None, max_length=120)


class InstitutionOut(BaseModel):
    name: str
    status: str
    cnpj: Optional[str] = None
    address: Optional[str] = None
    city: Optional[str] = None
    phone: Optional[str] = None
    email: Optional[str] = None
    site: Optional[str] = None
    signatory_name: Optional[str] = None
    signatory_role: Optional[str] = None
    has_logo: bool = False
    logo_filename: Optional[str] = None
    has_signature: bool = False
    signature_filename: Optional[str] = None
    has_proof: bool = False
    proof_filename: Optional[str] = None
    proof_uploaded_at: Optional[datetime] = None

    model_config = ConfigDict(from_attributes=True)


class VoidRequest(BaseModel):
    reason: Optional[str] = Field(default=None, max_length=250)
