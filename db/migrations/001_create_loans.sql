-- 001: loans table.
-- Applied automatically by the postgres image (docker-entrypoint-initdb.d) the first time the data
-- volume is initialised. It does NOT re-run on an existing volume - see README "Changing the schema".

CREATE TABLE IF NOT EXISTS loans (
    id            SERIAL        PRIMARY KEY,
    borrower_name TEXT          NOT NULL CHECK (char_length(borrower_name) BETWEEN 2 AND 100),
    loan_amount   NUMERIC(14,2) NOT NULL CHECK (loan_amount > 0),
    property_city TEXT,
    status        TEXT          NOT NULL DEFAULT 'PENDING'
                  CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED', 'DISBURSED')),
    created_at    TIMESTAMPTZ   NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ   NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_loans_status     ON loans (status);
CREATE INDEX IF NOT EXISTS idx_loans_created_at ON loans (created_at DESC);
