"""All SQL lives here. Every query is parameterised - no string formatting of user input."""

from decimal import Decimal
from typing import Protocol

import psycopg
from psycopg.rows import dict_row
from psycopg_pool import PoolTimeout

from .db import Database, DatabaseUnavailable
from .models import CityBucket, Loan, LoanCreate, LoanStats, LoanStatus, StatusBucket

_LOAN_COLUMNS = "id, borrower_name, loan_amount, property_city, status, created_at, updated_at"

SORT_ORDERS = {
    "newest": "created_at DESC, id DESC",
    "oldest": "created_at ASC, id ASC",
    "amount_desc": "loan_amount DESC, id DESC",
    "amount_asc": "loan_amount ASC, id ASC",
    "name": "borrower_name ASC, id ASC",
}


def _like_pattern(text: str) -> str:
    """Escape LIKE wildcards so a search for '50%' matches literally."""
    escaped = text.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
    return f"%{escaped}%"


class LoanRepository(Protocol):
    def list_loans(
        self, *, status: LoanStatus | None, search: str | None, sort: str, limit: int
    ) -> list[Loan]: ...

    def create_loan(self, loan: LoanCreate) -> Loan: ...

    def update_status(self, loan_id: int, status: LoanStatus) -> Loan | None: ...

    def stats(self) -> LoanStats: ...


class PostgresLoanRepository:
    def __init__(self, db: Database, instance_name: str) -> None:
        self._db = db
        self._instance = instance_name

    def _run(self, query: str, params: dict | None = None, *, many: bool = True):
        try:
            with self._db.connection() as conn, conn.cursor(row_factory=dict_row) as cur:
                cur.execute(query, params or {})
                return cur.fetchall() if many else cur.fetchone()
        except (psycopg.OperationalError, PoolTimeout) as exc:
            raise DatabaseUnavailable(str(exc)) from exc

    def list_loans(
        self, *, status: LoanStatus | None, search: str | None, sort: str, limit: int
    ) -> list[Loan]:
        # ORDER BY cannot be a bind parameter; it comes from a fixed allow-list, never from input.
        order_by = SORT_ORDERS[sort]
        rows = self._run(
            f"""
            SELECT {_LOAN_COLUMNS} FROM loans
            WHERE (%(status)s::text IS NULL OR status = %(status)s)
              AND (%(pattern)s::text IS NULL
                   OR borrower_name ILIKE %(pattern)s
                   OR property_city ILIKE %(pattern)s)
            ORDER BY {order_by}
            LIMIT %(limit)s
            """,  # noqa: S608 - only allow-listed identifiers are interpolated
            {
                "status": status.value if status else None,
                "pattern": _like_pattern(search) if search else None,
                "limit": limit,
            },
        )
        return [Loan(**row) for row in rows]

    def create_loan(self, loan: LoanCreate) -> Loan:
        row = self._run(
            f"""
            INSERT INTO loans (borrower_name, loan_amount, property_city, status)
            VALUES (%(borrower_name)s, %(loan_amount)s, %(property_city)s, %(status)s)
            RETURNING {_LOAN_COLUMNS}
            """,  # noqa: S608
            loan.model_dump(mode="python"),
            many=False,
        )
        return Loan(**row)

    def update_status(self, loan_id: int, status: LoanStatus) -> Loan | None:
        row = self._run(
            f"""
            UPDATE loans SET status = %(status)s, updated_at = now()
            WHERE id = %(id)s
            RETURNING {_LOAN_COLUMNS}
            """,  # noqa: S608
            {"id": loan_id, "status": status.value},
            many=False,
        )
        return Loan(**row) if row else None

    def stats(self) -> LoanStats:
        by_status = self._run(
            """
            SELECT status, COUNT(*) AS count, COALESCE(SUM(loan_amount), 0) AS total_amount
            FROM loans GROUP BY status ORDER BY status
            """
        )
        cities = self._run(
            """
            SELECT COALESCE(property_city, 'Unspecified') AS city,
                   COUNT(*) AS count, SUM(loan_amount) AS total_amount
            FROM loans GROUP BY 1 ORDER BY total_amount DESC, city LIMIT 6
            """
        )
        total_count = sum(r["count"] for r in by_status)
        total_amount = sum((r["total_amount"] for r in by_status), Decimal("0"))
        average = (
            (total_amount / total_count).quantize(Decimal("0.01")) if total_count else Decimal("0")
        )
        return LoanStats(
            total_count=total_count,
            total_amount=total_amount,
            average_amount=average,
            by_status=[StatusBucket(**r) for r in by_status],
            top_cities=[CityBucket(**r) for r in cities],
            served_by=self._instance,
        )
