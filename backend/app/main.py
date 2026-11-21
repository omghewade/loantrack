"""LoanTrack API.

Endpoints
  GET   /healthz          process is alive (never touches the database)
  GET   /readyz           database reachable -> 200, otherwise 503
  GET   /loans            list loans (?status=&q=&sort=&limit=)
  POST  /loans            create a loan
  PATCH /loans/{id}       change a loan's status
  GET   /stats            totals for the dashboard

Every response carries an X-Served-By header with the pod / container name, so scaling to
several replicas is visible from the browser or from curl.
"""

import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Annotated, Literal, Protocol, get_args

from fastapi import FastAPI, HTTPException, Query, Request, Response, status
from fastapi.responses import JSONResponse

from .config import Settings
from .db import Database, DatabaseUnavailable
from .models import Loan, LoanCreate, LoanList, LoanStats, LoanStatus, LoanStatusUpdate
from .repository import SORT_ORDERS, LoanRepository, PostgresLoanRepository

log = logging.getLogger("loantrack.api")

SortOrder = Literal["newest", "oldest", "amount_desc", "amount_asc", "name"]
if set(get_args(SortOrder)) != set(SORT_ORDERS):  # keep the API and the SQL allow-list in sync
    raise RuntimeError("SortOrder and SORT_ORDERS disagree")


class ReadinessCheck(Protocol):
    def start(self) -> None: ...
    def stop(self) -> None: ...
    def check(self) -> bool: ...


def create_app(
    repo: LoanRepository, db: ReadinessCheck, *, instance_name: str, version: str
) -> FastAPI:
    @asynccontextmanager
    async def lifespan(_: FastAPI) -> AsyncIterator[None]:
        log.info("starting loantrack-backend %s on %s", version, instance_name)
        db.start()
        yield
        log.info("shutting down, closing database pool")
        db.stop()

    app = FastAPI(title="LoanTrack API", version=version, lifespan=lifespan)

    @app.middleware("http")
    async def served_by_header(request: Request, call_next):
        response = await call_next(request)
        response.headers["X-Served-By"] = instance_name
        response.headers["X-App-Version"] = version
        return response

    @app.exception_handler(DatabaseUnavailable)
    async def database_unavailable(_: Request, exc: DatabaseUnavailable) -> JSONResponse:
        log.warning("request failed, database unavailable: %s", exc)
        return JSONResponse(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            content={"detail": "database unavailable, try again shortly"},
            headers={"Retry-After": "5"},
        )

    @app.get("/healthz", tags=["ops"])
    def healthz() -> dict:
        return {"status": "ok", "served_by": instance_name, "version": version}

    @app.get("/readyz", tags=["ops"])
    def readyz(response: Response) -> dict:
        if db.check():
            return {"status": "ready", "database": "reachable", "served_by": instance_name}
        response.status_code = status.HTTP_503_SERVICE_UNAVAILABLE
        return {"status": "not ready", "database": "unreachable", "served_by": instance_name}

    @app.get("/loans", response_model=LoanList, tags=["loans"])
    def list_loans(
        status_filter: Annotated[LoanStatus | None, Query(alias="status")] = None,
        q: Annotated[str | None, Query(max_length=60)] = None,
        sort: SortOrder = "newest",
        limit: Annotated[int, Query(ge=1, le=500)] = 200,
    ) -> LoanList:
        search = q.strip() if q and q.strip() else None
        items = repo.list_loans(status=status_filter, search=search, sort=sort, limit=limit)
        return LoanList(items=items, count=len(items), served_by=instance_name, version=version)

    @app.post("/loans", response_model=Loan, status_code=status.HTTP_201_CREATED, tags=["loans"])
    def create_loan(payload: LoanCreate) -> Loan:
        loan = repo.create_loan(payload)
        log.info(
            "created loan id=%s amount=%s city=%s", loan.id, loan.loan_amount, loan.property_city
        )
        return loan

    @app.patch("/loans/{loan_id}", response_model=Loan, tags=["loans"])
    def update_loan_status(loan_id: int, payload: LoanStatusUpdate) -> Loan:
        loan = repo.update_status(loan_id, payload.status)
        if loan is None:
            raise HTTPException(status_code=404, detail=f"loan {loan_id} not found")
        log.info("loan id=%s status -> %s", loan_id, payload.status)
        return loan

    @app.get("/stats", response_model=LoanStats, tags=["loans"])
    def stats() -> LoanStats:
        return repo.stats()

    return app


def build_app() -> FastAPI:
    """Factory used by uvicorn (`uvicorn app.main:build_app --factory`)."""
    settings = Settings.from_env()
    logging.basicConfig(
        level=settings.log_level,
        format="%(asctime)s %(levelname)-7s %(name)s: %(message)s",
    )
    db = Database(settings)
    repo = PostgresLoanRepository(db, settings.instance_name)
    return create_app(repo, db, instance_name=settings.instance_name, version=settings.app_version)
