-- 002: demo data - ten home loans across Indian cities, amounts in rupees.
-- Only inserts into an empty table, so running it twice never duplicates rows.

INSERT INTO loans (borrower_name, loan_amount, property_city, status, created_at, updated_at)
SELECT v.borrower_name, v.loan_amount, v.property_city, v.status, v.created_at, v.created_at
FROM (VALUES
    ('Aarav Sharma',       4500000.00, 'Mumbai',    'APPROVED',  now() - interval '18 days'),
    ('Priya Iyer',         7250000.00, 'Chennai',   'PENDING',   now() - interval '16 days'),
    ('Rohan Deshpande',    3800000.50, 'Pune',      'DISBURSED', now() - interval '14 days'),
    ('Ananya Reddy',       9100000.00, 'Hyderabad', 'REJECTED',  now() - interval '12 days'),
    ('Kabir Mehta',       12500000.00, 'Bengaluru', 'PENDING',   now() - interval '10 days'),
    ('Ishita Banerjee',    6200000.00, 'Kolkata',   'APPROVED',  now() - interval '8 days'),
    ('Vihaan Patel',       5400000.00, 'Ahmedabad', 'DISBURSED', now() - interval '6 days'),
    ('Diya Rathore',       3150000.00, 'Jaipur',    'PENDING',   now() - interval '4 days'),
    ('Arjun Nair',         8800000.00, 'Kochi',     'APPROVED',  now() - interval '2 days'),
    ('Saanvi Kulkarni',   15000000.00, 'Mumbai',    'PENDING',   now() - interval '1 day')
) AS v(borrower_name, loan_amount, property_city, status, created_at)
WHERE NOT EXISTS (SELECT 1 FROM loans);
