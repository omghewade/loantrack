from decimal import Decimal


def test_healthz_is_ok_even_when_database_is_down(client, db):
    db.ready = False
    response = client.get("/healthz")
    assert response.status_code == 200
    assert response.json()["status"] == "ok"


def test_readyz_follows_database_state(client, db):
    assert client.get("/readyz").status_code == 200
    db.ready = False
    response = client.get("/readyz")
    assert response.status_code == 503
    assert response.json()["database"] == "unreachable"


def test_lifespan_starts_and_stops_database(repo, db):
    from fastapi.testclient import TestClient

    from app.main import create_app

    with TestClient(create_app(repo, db, instance_name="p", version="v")):
        assert db.started
    assert db.stopped


def test_every_response_says_which_instance_served_it(client):
    response = client.get("/loans")
    assert response.headers["X-Served-By"] == "test-pod"
    assert response.json()["served_by"] == "test-pod"


def test_list_loans_newest_first(client):
    body = client.get("/loans").json()
    assert body["count"] == 5
    assert body["items"][0]["borrower_name"] == "Kabir Mehta"


def test_list_loans_filters_by_status_and_search(client):
    pending = client.get("/loans", params={"status": "PENDING"}).json()
    assert {x["borrower_name"] for x in pending["items"]} == {"Priya Iyer", "Kabir Mehta"}

    by_city = client.get("/loans", params={"q": "pune"}).json()
    assert [x["borrower_name"] for x in by_city["items"]] == ["Rohan Deshpande"]


def test_list_loans_sort_by_amount(client):
    items = client.get("/loans", params={"sort": "amount_desc"}).json()["items"]
    amounts = [Decimal(x["loan_amount"]) for x in items]
    assert amounts == sorted(amounts, reverse=True)


def test_list_loans_rejects_unknown_sort_and_status(client):
    assert client.get("/loans", params={"sort": "id; DROP TABLE loans"}).status_code == 422
    assert client.get("/loans", params={"status": "LOST"}).status_code == 422


def test_money_is_serialised_as_exact_string(client):
    item = client.get("/loans", params={"q": "Rohan"}).json()["items"][0]
    assert item["loan_amount"] == "3800000.50"


def test_create_loan_cleans_input(client):
    response = client.post(
        "/loans",
        json={
            "borrower_name": "  Meera   Nair ",
            "loan_amount": "5600000",
            "property_city": "Kochi",
        },
    )
    assert response.status_code == 201
    body = response.json()
    assert body["borrower_name"] == "Meera Nair"
    assert body["status"] == "PENDING"
    assert Decimal(body["loan_amount"]) == Decimal("5600000")


def test_create_loan_validation(client):
    bad_payloads = [
        {"borrower_name": "A", "loan_amount": "100"},
        {"borrower_name": "Valid Name", "loan_amount": "0"},
        {"borrower_name": "Valid Name", "loan_amount": "-5"},
        {"borrower_name": "Valid Name", "loan_amount": "10.123"},
        {"borrower_name": "Valid Name", "loan_amount": "100", "status": "LOST"},
        {"borrower_name": "Valid Name", "loan_amount": "100", "is_admin": True},
    ]
    for payload in bad_payloads:
        assert client.post("/loans", json=payload).status_code == 422, payload


def test_update_status(client):
    response = client.patch("/loans/2", json={"status": "APPROVED"})
    assert response.status_code == 200
    assert response.json()["status"] == "APPROVED"


def test_update_status_unknown_loan_is_404(client):
    assert client.patch("/loans/999", json={"status": "APPROVED"}).status_code == 404


def test_stats(client):
    body = client.get("/stats").json()
    assert body["total_count"] == 5
    assert Decimal(body["total_amount"]) == Decimal("37150000.50")


def test_database_outage_returns_503_not_500(client, repo):
    repo.available = False
    response = client.get("/loans")
    assert response.status_code == 503
    assert response.headers["Retry-After"] == "5"
