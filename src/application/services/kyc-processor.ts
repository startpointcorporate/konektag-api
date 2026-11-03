import { createWorker } from 'tesseract.js';
import { minioAdapter } from '../../infrastructure/adapters/minio-adapter.ts';
import { redisAdapter } from '../../infrastructure/adapters/redis-adapter.ts';
import { encryptionService } from '../../infrastructure/adapters/encryption-service.ts';
import { emailService } from './resend-service.ts';
import pool from '../../infrastructure/database/pool.ts';
import { getCorrelationId } from '../../infrastructure/correlation-id.ts';

function normalize(s: string): string {
  return s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z]/g, '');
}

export async function processKycOrder(kycOrderId: string): Promise<void> {
  const client = await pool.connect();
  try {
    // Load order
    const { rows: [order] } = await client.query(
      `SELECT * FROM konektag.kyc_orders WHERE id = $1`,
      [kycOrderId]
    );
    if (!order) {
      console.error(`[kyc-processor] Order ${kycOrderId} not found`);
      return;
    }
    if (order.status !== 'quarantined') {
      console.log(`[kyc-processor] Order ${kycOrderId} already processed (${order.status})`);
      return;
    }

    // Mark as scanning
    await client.query(
      `UPDATE konektag.kyc_orders SET status = 'scanning', updated_at = now() WHERE id = $1`,
      [kycOrderId]
    );
    await publishStatus(order.user_id, 'scanning');

    // Load user encrypted data
    const { rows: [userRow] } = await client.query(
      `SELECT encrypted_data, locale FROM konektag.users WHERE id = $1 AND deleted_at IS NULL`,
      [order.user_id]
    );
    if (!userRow) {
      await rejectOrder(kycOrderId, order.user_id, 'Utilisateur introuvable');
      return;
    }

    const locale = userRow.locale || 'fr';

    let userData: { firstName?: string; lastName?: string; email?: string };
    try {
      userData = JSON.parse(encryptionService.decrypt(userRow.encrypted_data));
    } catch {
      await rejectOrder(kycOrderId, order.user_id, 'Erreur de déchiffrement des données utilisateur');
      return;
    }

    // Download document from Minio
    let docBuffer: Buffer;
    try {
      docBuffer = await minioAdapter.downloadFromBucket(
        process.env.MINIO_QUARANTINE_BUCKET || 'konektag-kyc-quarantine',
        order.id_document_path
      );
    } catch (err) {
      console.error(`[kyc-processor] Failed to download document for order ${kycOrderId}:`, err);
      await rejectOrder(kycOrderId, order.user_id, 'Impossible de lire le document téléchargé. Veuillez réessayer.', 'DOCUMENT_DOWNLOAD_FAILED');
      return;
    }

    // Update status to processing
    await client.query(
      `UPDATE konektag.kyc_orders SET status = 'processing', updated_at = now() WHERE id = $1`,
      [kycOrderId]
    );
    await publishStatus(order.user_id, 'processing');

    // Run OCR with user's locale language
    let ocrText = '';
    try {
      const langMap: Record<string, string> = {
        fr: 'fra',
        en: 'eng',
        ar: 'ara',
        pt: 'por',
        es: 'spa',
        zh: 'chi_sim',
        hi: 'hin',
      };
      const tesseractLang = langMap[locale] || 'fra';
      const worker = await createWorker(tesseractLang, undefined, {
        // Tesseract otherwise throws rejected worker messages outside recognize().
        errorHandler: (ocrError) => console.error(`[kyc-processor] OCR worker error for order ${kycOrderId}:`, ocrError),
      });
      try {
        const { data } = await worker.recognize(docBuffer);
        ocrText = data.text;
      } finally {
        // A malformed input can make recognition fail after the worker starts.
        await worker.terminate().catch((terminateError) => {
          console.error(`[kyc-processor] OCR worker cleanup failed for order ${kycOrderId}:`, terminateError);
        });
      }
    } catch (err) {
      console.error(`[kyc-processor] OCR failed for order ${kycOrderId}:`, err);
      await rejectOrder(kycOrderId, order.user_id, msg('ocr_unreadable', locale), 'DOCUMENT_UNREADABLE');
      return;
    }

    // OCR is a triage signal, not proof of identity. Missing text must not
    // automatically reject a genuine document with OCR transcription errors.
    const ocrNormalized = normalize(ocrText);
    const lastName = normalize(userData.lastName ?? '');
    const firstName = normalize(userData.firstName ?? '');
    const lastNameFound = !!lastName && ocrNormalized.includes(lastName);
    const firstNameFound = !!firstName && ocrNormalized.includes(firstName);
    const ocrNeedsReview = !lastNameFound || !firstNameFound;
    await client.query(
      `UPDATE konektag.kyc_orders SET ocr_data = $1, updated_at = now() WHERE id = $2`,
      [JSON.stringify({
        rawText: ocrText,
        extractedAt: new Date().toISOString(),
        reviewRequired: ocrNeedsReview,
        reviewReason: ocrNeedsReview ? 'OCR_IDENTITY_MATCH_UNCERTAIN' : null,
        lastNameFound,
        firstNameFound,
      }), kycOrderId]
    );
    if (ocrNeedsReview) {
      console.info('[kyc-processor] OCR name matching uncertain; manual review required', { kycOrderId });
    }

    // OCR passed. Keep the document in quarantine until the administrator
    // explicitly approves the KYC. Moving it to verified here made pending_review
    // orders point to a path that no longer existed.
    // OCR passed — screening check avant admin review
    const { rows: [hit] } = await client.query(
      `SELECT id, full_name, match_type, list_name FROM konektag.screening_entries
       WHERE status = 'PENDING' AND created_at > now() - interval '30 days'
       LIMIT 1`,
    );

    if (hit) {
      await client.query(
        `INSERT INTO konektag.compliance_cases (case_ref, case_type, severity, subject_user_id, triggered_by, status, notes)
         VALUES ($1, $2, 'high', $3, 'kyc_screening', 'OPEN', $4)
         ON CONFLICT (case_ref) DO NOTHING`,
        [`KYC-HIT-${kycOrderId.slice(0, 8)}`, `${hit.match_type}_hit`, order.user_id,
         `Detection screening au KYC : ${hit.full_name} (${hit.list_name || 'sanctions list'})`],
      );

      await client.query(
        `UPDATE konektag.screening_entries SET linked_user_id = $1, status = 'MATCHED_USER' WHERE id = $2`,
        [order.user_id, hit.id],
      );
    }

    // Move to pending admin review
    await client.query(
      `UPDATE konektag.kyc_orders SET status = 'pending_review', updated_at = now() WHERE id = $1`,
      [kycOrderId]
    );

    // Update user state — en attente de validation manuelle
    await client.query(
      `UPDATE konektag.users SET state = 'KYC_PENDING_REVIEW', updated_at = now() WHERE id = $1 AND state IN ('KYC_PENDING', 'KYC_PROCESSING')`,
      [order.user_id]
    );

    const correlationId = getCorrelationId();
    await client.query(
      `INSERT INTO konektag.outbox_events (correlation_id, aggregate_type, aggregate_id, event_type, event_version, payload)
       VALUES ($1, 'KycOrder', $2, 'KycPendingReview', 1, $3)`,
       [correlationId, kycOrderId, JSON.stringify({ userId: order.user_id })]
    );

    // Publish Redis event for real-time SSE
    await publishStatus(order.user_id, 'pending_review', undefined, 'KYC_PENDING_REVIEW');

    console.log(`[kyc-processor] KYC pending admin review for user ${order.user_id}, order ${kycOrderId}`);

  } catch (err: any) {
    console.error(`[kyc-processor] Unexpected error for order ${kycOrderId}:`, err.message);
    try {
      await rejectOrder(kycOrderId,
        (await client.query(`SELECT user_id FROM konektag.kyc_orders WHERE id = $1`, [kycOrderId])).rows[0]?.user_id,
        'Une erreur technique est survenue. Veuillez réessayer.',
        'TECHNICAL_PROCESSING_FAILURE',
      );
    } catch {}
  } finally {
    client.release();
  }
}

async function rejectOrder(
  kycOrderId: string,
  userId: string | undefined,
  reason: string,
  rejectionCode?: string,
): Promise<void> {
  if (!userId) return;
  const client = await pool.connect();
  try {
    await client.query(
      `UPDATE konektag.kyc_orders SET status = 'rejected', rejection_reason = $1, updated_at = now() WHERE id = $2`,
      [reason, kycOrderId]
    );
    await client.query(
      `UPDATE konektag.users SET state = 'KYC_REJECTED', updated_at = now() WHERE id = $1 AND state IN ('KYC_PENDING', 'KYC_PROCESSING')`,
      [userId]
    );
    const correlationId = getCorrelationId();
    // Keep technical details out of the immutable audit payload.
    await client.query(
      `INSERT INTO konektag.audit_logs (user_id, correlation_id, event_type, payload)
       VALUES ($1, $2, $3, $4)`,
      [
        userId,
        correlationId,
        rejectionCode ? 'KYC_REJECTED_TECHNICAL' : 'KYC_REJECTED_AUTOMATED',
        JSON.stringify({ kycOrderId, ...(rejectionCode ? { rejectionCode } : {}) }),
      ],
    );
    await client.query(
      `INSERT INTO konektag.outbox_events (correlation_id, aggregate_type, aggregate_id, event_type, event_version, payload)
       VALUES ($1, 'KycOrder', $2, 'KycRejected', 1, $3)`,
       [correlationId, kycOrderId, JSON.stringify({ userId, reason, rejectionCode })]
    );
    await publishStatus(userId, 'rejected', reason, 'KYC_REJECTED');
    console.log(`[kyc-processor] KYC rejected for user ${userId}, order ${kycOrderId}: ${reason}`);
  } catch (err) {
    console.error(`[kyc-processor] Failed to reject order ${kycOrderId}:`, err);
  } finally {
    client.release();
  }
}

async function publishStatus(userId: string, status: string, reason?: string, step?: string): Promise<void> {
  try {
    const { redisAdapter: redis } = await import('../../infrastructure/adapters/redis-adapter.ts');
    await redis.publishKycStatus(userId, {
      status,
      step: step || `KYC_${status.toUpperCase()}`,
      reason,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    console.error(`[kyc-processor] Redis publish failed:`, err);
  }
}

const MESSAGES: Record<string, Record<string, string>> = {
  ocr_unreadable: {
    fr: 'La numérisation du document a échoué. Veuillez soumettre une image plus nette.',
    en: 'Document scanning failed. Please submit a clearer image.',
    ar: 'فشل مسح المستند. يرجى تقديم صورة أوضح.',
    pt: 'A digitalização do documento falhou. Envie uma imagem mais nítida.',
    es: 'El escaneo del documento falló. Envíe una imagen más clara.',
    sw: 'Uchanganuzi wa hati umeshindwa. Tafadhali wasilisha pia iliyo wazi zaidi.',
    zh: '文档扫描失败。请提交更清晰的图片。',
    hi: 'दस्तावेज़ स्कैन विफल रहा। कृपया एक स्पष्ट छवि सबमिट करें।',
  },
  first_name_mismatch: {
    fr: 'Prénom non trouvé sur le document.',
    en: 'First name not found on the document.',
    ar: 'الاسم الأول غير موجود في المستند.',
    pt: 'Primeiro nome não encontrado no documento.',
    es: 'Nombre de pila no encontrado en el documento.',
    sw: 'Jina la kwanza halipatikani kwenye hati.',
    zh: '在证件上未找到名字。',
    hi: 'दस्तावेज़ पर पहला नाम नहीं मिला।',
  },
  last_name_mismatch: {
    fr: 'Nom non trouvé sur le document.',
    en: 'Last name not found on the document.',
    ar: 'اسم العائلة غير موجود في المستند.',
    pt: 'Sobrenome não encontrado no documento.',
    es: 'Apellido no encontrado en el documento.',
    sw: 'Jina la mwisho halipatikani kwenye hati.',
    zh: '在证件上未找到姓氏。',
    hi: 'दस्तावेज़ पर अंतिम नाम नहीं मिला।',
  },
};

function msg(key: string, locale: string): string {
  return MESSAGES[key]?.[locale] || MESSAGES[key]?.fr || key;
}
