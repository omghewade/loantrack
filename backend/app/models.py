"""Request and response schemas.

Money is a Decimal end to end (NUMERIC(14,2) in Postgres) and is serialised as a string,
so ₹45,00,000.10 never turns into 4500000.0999999 on the way to the browser.
"""

from datetime import datetime
from decimal import Decimal
from enum import StrEnum

from pydantic import BaseModel, ConfigDict, Field, field_validator


class LoanStatus(StrEnum):
    PENDING = "PENDING"
    APPROVED = "APPROVED"
    REJECTED = "REJECTED"
    DISBURSED = "DISBURSED"


class LoanCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    borrower_name: str = Field(min_length=2, max_length=100)
    loan_amount: Decimal = Field(gt=0, max_digits=14, decimal_places=2)
    property_city: str | None = Field(default=None, max_length=60)
    status: LoanStatus = LoanStatus.PENDING

    @field_validator("borrower_name")
    @classmethod
    def _clean_name(cls, value: str) -> str:
        cleaned = " ".join(value.split())
        if len(cleaned) < 2:
            raise ValueError("borrower_name must have at least 2 visible characters")
        return cleaned

    @field_validator("property_city")
    @classmethod
    def _clean_city(cls, value: str | None) -> str | None:
        if value is None:
            return None
        cleaned = " ".join(value.split())
        return cleaned or None


class LoanStatusUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    status: LoanStatus


class Loan(BaseModel):
    id: int
    borrower_name: str
    loan_amount: Decimal
    property_city: str | None
    status: LoanStatus
    created_at: datetime
    updated_at: datetime


class LoanList(BaseModel):
    items: list[Loan]
    count: int
    served_by: str
    version: str


class StatusBucket(BaseModel):
    status: LoanStatus
    count: int
    total_amount: Decimal


class CityBucket(BaseModel):
    city: str
    count: int
    total_amount: Decimal


class LoanStats(BaseModel):
    total_count: int
    total_amount: Decimal
    average_amount: Decimal
    by_status: list[StatusBucket]
    top_cities: list[CityBucket]
    served_by: str
