import { RetryableError } from '../../domain/DomainErrors.ts';
import { getCorrelationId } from '../correlation-id.ts';

async function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export interface DifyChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

export interface DifyChatRequest {
  query: string;
  conversation_id?: string;
  user: string;
  inputs?: Record<string, unknown>;
  files?: Array<{
    type: string;
    url: string;
  }>;
  response_mode?: 'blocking' | 'streaming';
}

export interface DifyChatResponse {
  answer: string;
  conversation_id: string;
  message_id: string;
  created_at: number;
}

export interface DifyKnowledgeBaseListResponse {
  data: Array<{
    id: string;
    name: string;
    description: string;
    created_at: number;
  }>;
  total: number;
}

export interface DifyHealthResponse {
  pid: number;
  status: string;
  version: string;
}

export class DifyAdapter {
  constructor(
    private baseUrl: string,
    private apiKey: string,
  ) {}

  async health(): Promise<DifyHealthResponse> {
    for (let i = 0; i <= 3; i++) {
      try {
        const res = await fetch(`${this.baseUrl}/health`, {
          method: 'GET',
          headers: {
            'Content-Type': 'application/json',
            ...(this.apiKey ? { 'Authorization': `Bearer ${this.apiKey}` } : {}),
            'X-Correlation-Id': getCorrelationId(),
          },
          signal: AbortSignal.timeout(5000),
        });
        if (res.ok) return res.json() as Promise<DifyHealthResponse>;
        if (res.status !== 404) throw new RetryableError(`Dify health: ${res.status}`);

        // The public reverse proxy does not expose /health, but it does expose
        // the authenticated API info endpoint used by production checks.
        const infoRes = await fetch(`${this.baseUrl}/v1/info`, {
          method: 'GET',
          headers: {
            'Content-Type': 'application/json',
            ...(this.apiKey ? { 'Authorization': `Bearer ${this.apiKey}` } : {}),
            'X-Correlation-Id': getCorrelationId(),
          },
          signal: AbortSignal.timeout(5000),
        });
        if (!infoRes.ok) throw new RetryableError(`Dify info: ${infoRes.status}`);
        const info = await infoRes.json() as { version?: string; status?: string; pid?: number };
        return { pid: info.pid ?? 0, status: info.status ?? 'ok', version: info.version ?? 'unknown' };
      } catch (err) {
        if (i < 3) await sleep(Math.min(1000 * Math.pow(2, i), 8000));
        else throw err;
      }
    }
    throw new RetryableError('Dify health: unreachable');
  }

  async chat(request: DifyChatRequest): Promise<DifyChatResponse> {
    for (let i = 0; i <= 5; i++) {
      try {
        const res = await fetch(`${this.baseUrl}/v1/chat-messages`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${this.apiKey}`,
            'X-Correlation-Id': getCorrelationId(),
          },
          body: JSON.stringify({
            ...request,
            response_mode: request.response_mode ?? 'blocking',
          }),
          signal: AbortSignal.timeout(60000),
        });
        if (!res.ok) {
          const text = await res.text().catch(() => '');
          throw new RetryableError(`Dify chat: ${res.status} ${text.slice(0, 200)}`);
        }
        return res.json() as Promise<DifyChatResponse>;
      } catch (err) {
        if (i < 5) await sleep(Math.min(1000 * Math.pow(2, i), 16000));
        else throw err;
      }
    }
    throw new RetryableError('Dify chat: exhausted retries');
  }

  async listKnowledgeBases(): Promise<DifyKnowledgeBaseListResponse> {
    for (let i = 0; i <= 5; i++) {
      try {
        const res = await fetch(`${this.baseUrl}/v1/datasets?page=1&limit=50`, {
          method: 'GET',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${this.apiKey}`,
            'X-Correlation-Id': getCorrelationId(),
          },
          signal: AbortSignal.timeout(15000),
        });
        if (!res.ok) throw new RetryableError(`Dify KB list: ${res.status}`);
        return res.json() as Promise<DifyKnowledgeBaseListResponse>;
      } catch (err) {
        if (i < 5) await sleep(Math.min(1000 * Math.pow(2, i), 16000));
        else throw err;
      }
    }
    throw new RetryableError('Dify KB list: exhausted retries');
  }
}

const difyBaseUrl = process.env.DIFY_BASE_URL?.replace(/\/+$/, '') ?? 'https://diffy.2mbiweb.com';
const difyApiKey = process.env.DIFY_API_KEY ?? '';

export const difyAdapter = new DifyAdapter(difyBaseUrl, difyApiKey);
