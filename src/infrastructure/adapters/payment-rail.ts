export interface PaymentRailProof {
  reference: string;
  actor: string;
  amount: number;
  currency: string;
  timestamp: string;
  status: string;
  signatureVerification?: string;
  rawBody?: unknown;
}

export interface PaymentRailAdapter {
  name: string;
  isConfigured: () => boolean;
  verifyProof: (proof: PaymentRailProof) => Promise<{
    valid: boolean;
    error?: string;
  }>;
}

export function paymentRailNotConfigured(rail: string): PaymentRailAdapter {
  return {
    name: rail,
    isConfigured: () => false,
    verifyProof: async () => ({ valid: false, error: `Rail ${rail} NOT_CONFIGURED` }),
  };
}

export function createPaymentRailAdapter(
  rail: string,
  config: { enabled: boolean; verifySignature?: (body: string, signature: string) => boolean }
): PaymentRailAdapter {
  if (!config.enabled) {
    return paymentRailNotConfigured(rail);
  }

  return {
    name: rail,
    isConfigured: () => true,
    verifyProof: async (proof) => {
      if (!proof.reference || !proof.amount) {
        return { valid: false, error: 'Missing required proof fields' };
      }
      if (config.verifySignature && proof.signatureVerification) {
        const valid = config.verifySignature(
          JSON.stringify(proof.rawBody),
          proof.signatureVerification
        );
        if (!valid) {
          return { valid: false, error: 'Proof signature verification failed' };
        }
      }
      return { valid: true };
    },
  };
}
