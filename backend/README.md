# Backend — notas de implementação

## Banco de dados

O MVP usa SQLite. O arquivo físico `bemrecibo.db` é criado automaticamente em
`backend/` quando a API inicia.

`schema.sql` documenta as tabelas:

- `institution`: dados e status de habilitação da instituição.
- `donors`: cadastro PF/PJ.
- `donations`: registro individual e regras aplicadas no momento da emissão.
- `documents`: vínculo entre documento e doação de origem.

O campo `institution_status_snapshot` preserva o status da instituição no
momento em que a doação foi registrada. A reemissão consulta a doação original,
sem criar outra operação.

## Migrações

`database.py` mantém um mapa `MIGRATIONS` aplicado no start da API: colunas
novas são adicionadas com `ALTER TABLE ... ADD COLUMN` apenas quando ausentes.
Isso permite atualizar uma instalação antiga sem perder registros e sem
ferramenta externa de migração.

## Convenções

- Numeração: `BR-<ano>-<sequencial com 6 dígitos>`, reiniciada por exercício.
- PDFs não são armazenados: são gerados sob demanda a partir do registro,
  garantindo que o documento reflita sempre os dados atuais da instituição.
- Cancelamento é lógico (`voided`), nunca exclusão física.
- Valores monetários usam `Float` no MVP; para produção com muitas operações,
  migrar para `Numeric(12, 2)`.

## Estrutura de módulos

| Arquivo | Responsabilidade |
| --- | --- |
| `main.py` | Rotas HTTP, regras de emissão, filtros e indicadores |
| `models.py` | Mapeamento das tabelas |
| `schemas.py` | Contratos Pydantic (entrada e saída) |
| `services.py` | Geração de PDF, valor por extenso, formatação pt-BR |
| `database.py` | Engine, sessão, migrações leves |

## Testes

```bash
pip install -r requirements-dev.txt
python -m pytest -q
```

Os testes usam um banco SQLite temporário, criado e destruído a cada teste.
