"""Popula o banco com dados de demonstração para a apresentação do projeto.

Uso:
    python seed_demo.py            # insere os dados se o banco estiver vazio
    python seed_demo.py --reset    # apaga doações/doadores e recria a demonstração

Não é executado automaticamente pela API.
"""
from __future__ import annotations

import sys
from datetime import date, datetime, timezone

from bemrecibo.database import Base, SessionLocal, apply_light_migrations, engine
from bemrecibo import models

INSTITUTION = {
    "name": "Instituto Pelo Bem",
    "address": "Rua Pedro Henrique, 300 — Santo Amaro",
    "city": "Recife - PE",
    "email": "contato@institutopelobem.org.br",
}

DONORS = [
    ("PF", "Maria de Souza Lima", "123.456.789-01", "maria.lima@email.com", "(81) 98811-2233", None),
    ("PF", "João Pedro Alves", "234.567.890-12", "joao.alves@email.com", "(81) 99722-4455", None),
    ("PF", "Ana Beatriz Correia", "345.678.901-23", "ana.correia@email.com", "(81) 98111-7788", None),
    ("PF", "Carlos Eduardo Ferreira", "456.789.012-34", "carlos.ferreira@email.com", "(81) 99888-1122", None),
    ("PJ", "Padaria Santo Amaro ME", "12.345.678/0001-90", "financeiro@padariastoamaro.com.br", "(81) 3222-1010", "Rita Albuquerque"),
    ("PJ", "Grupo Nordeste Logística LTDA", "23.456.789/0001-01", "contato@gnlogistica.com.br", "(81) 3421-5566", "Marcos Vinícius"),
    ("PJ", "Associação dos Moradores de Santo Amaro", "34.567.890/0001-12", "associacao@amsa.org.br", "(81) 3033-7788", "Lúcia Ramos"),
]

# (tax_id, modalidade, data, finalidade, forma, valor, descrição, qtd, valor estimado, marca, nota fiscal)
DONATIONS = [
    ("12.345.678/0001-90", "financeira", date(2026, 8, 12), "Compra de cestas básicas", "Transferência bancária", 2500.00, None, None, None, None, None),
    ("123.456.789-01", "financeira", date(2026, 8, 21), "Apoio às atividades assistenciais", "PIX", 350.00, None, None, None, None, None),
    ("23.456.789/0001-01", "financeira", date(2026, 9, 3), "Manutenção do espaço", "Transferência bancária", 5000.00, None, None, None, None, None),
    ("234.567.890-12", "financeira", date(2026, 9, 15), "Apoio às atividades assistenciais", "Dinheiro", 200.00, None, None, None, None, None),
    ("34.567.890/0001-12", "bem", date(2026, 9, 27), "Distribuição de cestas", "Entrega presencial", None, "Cestas básicas de 15 kg", 20, 2400.00, "Cesta padrão", "NF-e 4471"),
    ("345.678.901-23", "financeira", date(2026, 10, 5), "Kit de higiene pessoal", "PIX", 480.00, None, None, None, None, None),
    ("12.345.678/0001-90", "bem", date(2026, 10, 14), "Lanches para oficinas", "Entrega presencial", None, "Pães e bolos artesanais", 60, 900.00, "Produção própria", "NF-e 8820"),
    ("456.789.012-34", "financeira", date(2026, 10, 28), "Apoio às atividades assistenciais", "PIX", 1200.00, None, None, None, None, None),
    ("23.456.789/0001-01", "financeira", date(2026, 11, 4), "Manutenção do espaço", "Boleto", 3000.00, None, None, None, None, None),
    ("123.456.789-01", "bem", date(2026, 11, 7), "Doação de mobiliário", "Entrega presencial", None, "Cadeiras plásticas brancas", 12, 1440.00, "Tramontina", "Recibo simples"),
]


def reset(session) -> None:
    session.query(models.Document).delete()
    session.query(models.Donation).delete()
    session.query(models.Donor).delete()
    session.commit()


def seed(session) -> None:
    institution = session.query(models.Institution).filter(models.Institution.id == 1).first()
    if not institution:
        institution = models.Institution(id=1, status="nao_habilitada", **INSTITUTION)
        session.add(institution)
    else:
        for field, value in INSTITUTION.items():
            if not getattr(institution, field):
                setattr(institution, field, value)
    session.commit()

    donors = {}
    for person_type, name, tax_id, email, phone, representative in DONORS:
        donor = session.query(models.Donor).filter(models.Donor.tax_id == tax_id).first()
        if not donor:
            donor = models.Donor(
                person_type=person_type, name=name, tax_id=tax_id,
                email=email, phone=phone, representative=representative,
            )
            session.add(donor)
            session.flush()
        donors[tax_id] = donor

    counter = 1
    for (tax_id, modality, received_at, purpose, payment, amount,
         description, quantity, estimated, brand, fiscal) in DONATIONS:
        donor = donors[tax_id]
        number = f"BR-{received_at.year}-{counter:06d}"
        if session.query(models.Donation).filter(models.Donation.number == number).first():
            counter += 1
            continue
        document_type = (
            "Termo de Doação e Entrega" if modality == "bem"
            else ("Recibo de Doação PF" if donor.person_type == "PF" else "Recibo de Doação PJ")
        )
        donation = models.Donation(
            number=number, donor_id=donor.id, donation_type=modality,
            received_at=received_at, purpose=purpose, payment_method=payment,
            amount=amount, description=description, quantity=quantity,
            estimated_value=estimated, brand_model=brand, fiscal_document=fiscal,
            document_type=document_type, institution_status_snapshot="nao_habilitada",
            warning_applied=True, created_at=datetime.combine(received_at, datetime.min.time(),
                                                              tzinfo=timezone.utc),
        )
        session.add(donation)
        session.flush()
        session.add(models.Document(donation_id=donation.id, document_type=document_type,
                                    filename=f"{number}.pdf"))
        counter += 1
    session.commit()


def main() -> None:
    Base.metadata.create_all(bind=engine)
    apply_light_migrations()
    session = SessionLocal()
    try:
        if "--reset" in sys.argv:
            reset(session)
        if session.query(models.Donation).count():
            print("Banco já possui doações. Use --reset para recriar a demonstração.")
            return
        seed(session)
        print(f"Demonstração criada: {session.query(models.Donor).count()} doadores e "
              f"{session.query(models.Donation).count()} doações.")
    finally:
        session.close()


if __name__ == "__main__":
    main()
