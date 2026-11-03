CREATE TABLE IF NOT EXISTS konektag.pro_inquiries (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    business_name VARCHAR(200) NOT NULL,
    email VARCHAR(200) NOT NULL,
    phone VARCHAR(30),
    country VARCHAR(100),
    offer_name VARCHAR(100) NOT NULL DEFAULT 'Pro',
    message TEXT,
    status VARCHAR(20) NOT NULL DEFAULT 'pending',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
