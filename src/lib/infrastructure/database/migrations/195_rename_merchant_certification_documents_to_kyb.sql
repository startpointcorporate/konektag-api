BEGIN;
ALTER TABLE IF EXISTS konektag.merchant_certification_documents
  RENAME TO merchant_kyb_documents;
ALTER INDEX IF EXISTS konektag.idx_cert_docs_profile RENAME TO idx_kyb_docs_profile;
ALTER INDEX IF EXISTS konektag.idx_cert_docs_type RENAME TO idx_kyb_docs_type;
COMMIT;
