from datetime import UTC, datetime, timedelta
from decimal import Decimal

import pytest
from fastapi.testclient import TestClient

from app.db import DatabaseUnavailable
from app.main import create_app
from app.models import CityBucket, Loan, LoanCreate, LoanStats, LoanStatus, StatusBucket

SEED = [
    ("Aarav Sharma", "4500000.00", "Mumbai", LoanStatus.APPROVED),
    ("Priya Iyer", "7250000.00", "Chennai", LoanStatus.PENDING),
    ("Rohan Deshpande", "3800000.50", "Pune", LoanStatus.DISBURSED),
    ("Ananya Reddy", "9100000.00", "Hyderabad", LoanStatus.REJECTED),
    ("Kabir Mehta", "12500000.00", "Bengaluru", LoanStatus.PENDING),
]


class FakeRepo:
    """In-memory stand-in for PostgresLoanRepository."""

    def __init__(self) -> None:
        start = datetime(2026, 11, 1, 10, 0, tzinfo=UTC)
        self.available = True
        self.loans: list[Loan] = [
            Loan(
                id=i + 1,
                borrower_name=name,
                loan_amount=Decimal(amount),
                property_city=city,
                status=st,
                created_at=start + timedelta(days=i),
                updated_at=start + timedelta(days=i),
            )
            for i, (name, amount, city, st) in enumerate(SEED)
        ]

    def _guard(self) -> None:
        if not self.available:
            raise DatabaseUnavailable("fake outage")

    def list_loans(self, *, status, search, sort, limit):
        self._guard()
        items = [
            loan
            for loan in self.loans
            if (status is None or loan.status == status)
            and (
                search is None
                or search.lower() in loan.borrower_name.lower()
                or search.lower() in (loan.property_city or "").lower()
            )
        ]
        keys = {
            "newest": (lambda x: x.created_at, True),
            "oldest": (lambda x: x.created_at, False),
            "amount_desc": (lambda x: x.loan_amount, True),
            "amount_asc": (lambda x: x.loan_amount, False),
            "name": (lambda x: x.borrower_name, False),
        }
        key, reverse = keys[sort]
        return sorted(items, key=key, reverse=reverse)[:limit]

    def create_loan(self, loan: LoanCreate) -> Loan:
        self._guard()
        now = datetime.now(UTC)
        created = Loan(id=len(self.loans) + 1, created_at=now, updated_at=now, **loan.model_dump())
        self.loans.append(created)
        return created

    def update_status(self, loan_id, status):
        self._guard()
        for i, loan in enumerate(self.loans):
            if loan.id == loan_id:
                self.loans[i] = loan.model_copy(update={"status": status})
                return self.loans[i]
        return None

    def stats(self) -> LoanStats:
        self._guard()
        total = sum((x.loan_amount for x in self.loans), Decimal("0"))
        return LoanStats(
            total_count=len(self.loans),
            total_amount=total,
            average_amount=(total / len(self.loans)).quantize(Decimal("0.01")),
            by_status=[
                StatusBucket(
                    status=s,
                    count=sum(1 for x in self.loans if x.status == s),
                    total_amount=sum(
                        (x.loan_amount for x in self.loans if x.status == s), Decimal("0")
                    ),
                )
                for s in LoanStatus
            ],
            top_cities=[
                CityBucket(city=x.property_city, count=1, total_amount=x.loan_amount)
                for x in self.loans
            ],
            served_by="test-pod",
        )


class FakeDb:
    def __init__(self) -> None:
        self.ready = True
        self.started = False
        self.stopped = False

    def start(self) -> None:
        self.started = True

    def stop(self) -> None:
        self.stopped = True

    def check(self) -> bool:
        return self.ready


@pytest.fixture
def repo() -> FakeRepo:
    return FakeRepo()


@pytest.fixture
def db() -> FakeDb:
    return FakeDb()


@pytest.fixture
def client(repo: FakeRepo, db: FakeDb):
    app = create_app(repo, db, instance_name="test-pod", version="test")
    with TestClient(app) as test_client:
        yield test_client
