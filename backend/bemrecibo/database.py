"""Configuração de banco de dados do BemRecibo.

O MVP usa SQLite por padrão (`backend/bemrecibo.db`). A URL pode ser trocada
por variável de ambiente `DATABASE_URL` sem alterar o código da aplicação.
"""
from pathlib import Path
import os

from sqlalchemy import create_engine, inspect, text
from sqlalchemy.orm import declarative_base, sessionmaker

BASE_DIR = Path(__file__).resolve().parents[1]
DEFAULT_SQLITE_PATH = BASE_DIR / "bemrecibo.db"

DATABASE_URL = os.getenv("DATABASE_URL") or f"sqlite:///{DEFAULT_SQLITE_PATH}"
CONNECT_ARGS = {"check_same_thread": False} if DATABASE_URL.startswith("sqlite") else {}

engine = create_engine(DATABASE_URL, connect_args=CONNECT_ARGS, pool_pre_ping=True)
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
Base = declarative_base()


# Colunas adicionadas depois da primeira versão do banco.
# São aplicadas de forma incremental e idempotente, sem recriar tabelas
# nem perder registros já gravados.
MIGRATIONS = {
    "institution": {
        "cnpj": "VARCHAR(20)",
        "address": "VARCHAR(200)",
        "city": "VARCHAR(120)",
        "phone": "VARCHAR(40)",
        "email": "VARCHAR(180)",
        "site": "VARCHAR(180)",
        "proof_uploaded_at": "DATETIME",
    },
    "donations": {
        "voided": "BOOLEAN NOT NULL DEFAULT 0",
        "void_reason": "VARCHAR(250)",
        "voided_at": "DATETIME",
    },
}


def apply_light_migrations() -> list[str]:
    """Adiciona colunas ausentes em bancos criados por versões anteriores."""
    applied: list[str] = []
    inspector = inspect(engine)
    tables = set(inspector.get_table_names())
    with engine.begin() as conn:
        for table, columns in MIGRATIONS.items():
            if table not in tables:
                continue
            existing = {column["name"] for column in inspector.get_columns(table)}
            for name, ddl in columns.items():
                if name not in existing:
                    conn.execute(text(f"ALTER TABLE {table} ADD COLUMN {name} {ddl}"))
                    applied.append(f"{table}.{name}")
    return applied


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
