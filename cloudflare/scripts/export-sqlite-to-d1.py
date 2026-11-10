#!/usr/bin/env python3
"""Exporta os dados do SQLite do backend Python para um arquivo SQL do D1.

Uso:
    python cloudflare/scripts/export-sqlite-to-d1.py [origem.db] [destino.sql]

Padrões: backend/bemrecibo.db  ->  cloudflare/seed.sql

O arquivo gerado usa INSERT OR REPLACE, então pode ser aplicado mais de uma vez:
    npx wrangler d1 execute bemrecibo --remote --file=seed.sql
"""
from __future__ import annotations

import sqlite3
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_SOURCE = ROOT / "backend" / "bemrecibo.db"
DEFAULT_TARGET = ROOT / "cloudflare" / "seed.sql"

# ordem respeita as chaves estrangeiras
TABLES = ["institution", "donors", "donations", "documents"]


def sql_literal(value) -> str:
    if value is None:
        return "NULL"
    if isinstance(value, bool):
        return "1" if value else "0"
    if isinstance(value, (int, float)):
        return repr(value)
    if isinstance(value, bytes):
        return "X'" + value.hex() + "'"
    text = str(value)
    # datas do SQLAlchemy vêm como "2026-08-12 00:00:00.000000": normaliza para ISO
    if len(text) == 26 and text[10] == " " and text[19] == ".":
        text = text.replace(" ", "T")
    return "'" + text.replace("'", "''") + "'"


def export(source: Path, target: Path) -> dict[str, int]:
    if not source.exists():
        raise SystemExit(f"Banco não encontrado: {source}")

    connection = sqlite3.connect(source)
    connection.row_factory = sqlite3.Row
    counts: dict[str, int] = {}
    lines = [
        "-- Dados exportados do SQLite do BemRecibo para o Cloudflare D1.",
        f"-- Origem: {source.name}",
        "-- Aplicar com: npx wrangler d1 execute bemrecibo --remote --file=seed.sql",
        "",
    ]

    for table in TABLES:
        try:
            rows = connection.execute(f"SELECT * FROM {table}").fetchall()
        except sqlite3.Error:
            counts[table] = 0
            continue

        counts[table] = len(rows)
        if not rows:
            continue

        columns = list(rows[0].keys())
        # colunas que existem na origem mas não no schema do D1 são ignoradas
        column_sql = ", ".join(columns)
        lines.append(f"-- {table}: {len(rows)} registro(s)")
        for row in rows:
            values = ", ".join(sql_literal(row[column]) for column in columns)
            lines.append(f"INSERT OR REPLACE INTO {table} ({column_sql}) VALUES ({values});")
        lines.append("")

    connection.close()
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text("\n".join(lines), encoding="utf-8")
    return counts


def main() -> None:
    source = Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else DEFAULT_SOURCE
    target = Path(sys.argv[2]).resolve() if len(sys.argv) > 2 else DEFAULT_TARGET

    counts = export(source, target)
    total = sum(counts.values())
    print(f"Exportado para {target}")
    for table, count in counts.items():
        print(f"  {table:<12} {count} registro(s)")
    print(f"Total: {total} registro(s)")
    if total == 0:
        print("Aviso: o banco de origem está vazio.")


if __name__ == "__main__":
    main()
