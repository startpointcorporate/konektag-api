import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DifyAdapter } from '../../src/infrastructure/adapters/dify-adapter.ts';

describe('DifyAdapter', () => {
  let adapter: DifyAdapter;

  beforeEach(() => {
    adapter = new DifyAdapter('https://diffy.2mbiweb.com', 'test-api-key');
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('health', () => {
    it('returns health status when API is reachable', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response(JSON.stringify({ pid: 1, status: 'ok', version: '1.16.0' }), { status: 200 })
      );

      const result = await adapter.health();
      expect(result).toEqual({ pid: 1, status: 'ok', version: '1.16.0' });
      expect(fetch).toHaveBeenCalledWith(
        'https://diffy.2mbiweb.com/health',
        expect.objectContaining({
          method: 'GET',
          headers: expect.objectContaining({ 'Content-Type': 'application/json' }),
        })
      );
    });

    it('retries on failure and throws after exhausting retries', async () => {
      vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Network error'));

      await expect(adapter.health()).rejects.toThrow('Network error');
      expect(fetch).toHaveBeenCalledTimes(4);
    }, 10000);
  });

  describe('chat', () => {
    it('constructs a valid chat request', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response(JSON.stringify({
          answer: 'Hello',
          conversation_id: 'conv-1',
          message_id: 'msg-1',
          created_at: 1234567890,
        }), { status: 200 })
      );

      const result = await adapter.chat({
        query: 'Hello',
        user: 'user-1',
      });

      expect(result.answer).toBe('Hello');
      expect(result.conversation_id).toBe('conv-1');
      expect(fetch).toHaveBeenCalledWith(
        'https://diffy.2mbiweb.com/v1/chat-messages',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            'Authorization': 'Bearer test-api-key',
            'Content-Type': 'application/json',
          }),
        })
      );
    });

    it('retries on server errors', async () => {
      vi.spyOn(globalThis, 'fetch')
        .mockRejectedValueOnce(new Error('Timeout'))
        .mockResolvedValueOnce(
          new Response(JSON.stringify({
            answer: 'Hello',
            conversation_id: 'conv-1',
            message_id: 'msg-1',
            created_at: 1234567890,
          }), { status: 200 })
        );

      const result = await adapter.chat({
        query: 'Hello',
        user: 'user-1',
      });

      expect(result.answer).toBe('Hello');
      expect(fetch).toHaveBeenCalledTimes(2);
    });
  });

  describe('listKnowledgeBases', () => {
    it('returns list of knowledge bases', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response(JSON.stringify({
          data: [{ id: 'kb-1', name: 'Public KB', description: '', created_at: 0 }],
          total: 1,
        }), { status: 200 })
      );

      const result = await adapter.listKnowledgeBases();
      expect(result.data).toHaveLength(1);
      expect(result.data[0].name).toBe('Public KB');
    });

    it('handles empty response', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response(JSON.stringify({ data: [], total: 0 }), { status: 200 })
      );

      const result = await adapter.listKnowledgeBases();
      expect(result.data).toHaveLength(0);
    });
  });
});
