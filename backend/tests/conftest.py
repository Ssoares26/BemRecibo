"""Configuração comum dos testes: banco isolado e cliente HTTP."""
import os
import tempfile
from pathlib import Path

import pytest

TEST_DB = Path(tempfile.gettempdir()) / "bemrecibo_test.db"
os.environ["DATABASE_URL"] = f"sqlite:///{TEST_DB}"
os.environ.setdefault("ALLOWED_ORIGINS", "*")

from fastapi.testclient import TestClient  # noqa: E402

from bemrecibo.database import Base, engine  # noqa: E402
from bemrecibo.main import app  # noqa: E402


@pytest.fixture()
def client():
    Base.metadata.drop_all(bind=engine)
    Base.metadata.create_all(bind=engine)
    with TestClient(app) as test_client:
        yield test_client
    Base.metadata.drop_all(bind=engine)


PF_DONATION = {
    "person_type": "PF",
    "donor_name": "Maria de Souza Lima",
    "tax_id": "123.456.789-01",
    "email": "maria@example.com",
    "donation_type": "financeira",
    "received_at": "2026-11-10",
    "purpose": "Apoio às atividades assistenciais",
    "payment_method": "PIX",
    "amount": 1500.50,
}

PJ_DONATION = {
    "person_type": "PJ",
    "donor_name": "Padaria Santo Amaro ME",
    "tax_id": "12.345.678/0001-90",
    "representative": "Rita Albuquerque",
    "donation_type": "financeira",
    "received_at": "2026-11-11",
    "purpose": "Compra de cestas básicas",
    "payment_method": "Transferência bancária",
    "amount": 2500.0,
}

GOODS_DONATION = {
    "person_type": "PJ",
    "donor_name": "Grupo Nordeste Logística LTDA",
    "tax_id": "23.456.789/0001-01",
    "donation_type": "bem",
    "received_at": "2026-11-12",
    "purpose": "Distribuição de cestas",
    "description": "Cestas básicas de 15 kg",
    "quantity": 20,
    "estimated_value": 2400.0,
    "brand_model": "Cesta padrão",
    "fiscal_document": "NF-e 4471",
}


@pytest.fixture()
def sample_donation(client):
    response = client.post("/donations", json=PF_DONATION)
    assert response.status_code == 200, response.text
    return response.json()
