import { describe, it, expect, beforeEach, afterEach, vi } from 'bun:test';
import { AIGatewayHealthService, AIProviderStatus, AIGatewayHealth } from '../../../services/ai-gateway-health';

// Mock fetch globally
global.fetch = vi.fn();

describe('AIGatewayHealthService', () => {
  let service: AIGatewayHealthService;
  const mockGatewayUrl = 'http://127.0.0.1:37778';

  beforeEach(() => {
    service = new AIGatewayHealthService(mockGatewayUrl, 1000); // 1 second interval for testing
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
    // Ensure any intervals are cleared
    if (service['pollingInterval']) {
      clearInterval(service['pollingInterval']);
    }
  });

  it('should start polling and perform initial health check', async () => {
    const mockHealth: AIGatewayHealth = {
      status: 'ok',
      providers: [
        { name: 'groq', configured: true, model: 'test', healthy: true },
      ],
      timestamp: new Date().toISOString(),
      uptimeMs: 1000
    };

    fetch.mockResolvedValueOnce({
      ok: true,
      json: async () => mockHealth
    } as Response);

    await service.start();

    // Should have called fetch for initial check
    expect(fetch).toHaveBeenCalledWith(`${mockGatewayUrl}/health`, {
      timeout: 5000
    });

    // Should have started polling interval
    expect(service['isPolling']).toBe(true);
    expect(service['pollingInterval']).not.toBeNull();

    // Get last health should return the mocked health
    const health = service.getLastHealth();
    expect(health).not.toBeNull();
    if (health) {
      expect(health.status).toBe('ok');
      expect(health.providers.length).toBe(1);
    }
  });

  it('should stop polling and clear interval', async () => {
    await service.start();
    expect(service['isPolling']).toBe(true);
    expect(service['pollingInterval']).not.toBeNull();

    await service.stop();
    expect(service['isPolling']).toBe(false);
    expect(service['pollingInterval']).toBeNull();
  });

  it('should handle successful health check with latency', async () => {
    const mockHealth: AIGatewayHealth = {
      status: 'ok',
      providers: [
        { name: 'groq', configured: true, model: 'test', healthy: true, latencyMs: 50 },
        { name: 'gemini', configured: true, model: 'test', healthy: true, latencyMs: 30 }
      ],
      timestamp: new Date().toISOString(),
      uptimeMs: 5000
    };

    fetch.mockResolvedValueOnce({
      ok: true,
      json: async () => mockHealth
    } as Response);

    const health = await service.checkHealth();

    expect(health.status).toBe('ok');
    expect(health.providers.length).toBe(2);
    // Latency should be distributed (we don't check exact value as it's implementation detail)
    expect(health.providers[0].latencyMs).toBeDefined();
    expect(health.providers[1].latencyMs).toBeDefined();
  });

  it('should handle failed health check and return degraded state', async () => {
    // First call fails
    fetch.mockRejectedValueOnce(new Error('Network error'));

    const health = await service.checkHealth();

    expect(health.status).toBe('error'); // First call returns error
    expect(health.providers.length).toBe(0);

    // Second call should use last known good state (none) but we can test that it doesn't crash
    fetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        status: 'ok',
        providers: [{ name: 'groq', configured: true, model: 'test', healthy: true }],
        timestamp: new Date().toISOString(),
        uptimeMs: 1000
      } as AIGatewayHealth)
    } as Response);

    const health2 = await service.checkHealth();
    expect(health2.status).toBe('ok');
  });

  it('should return correct provider status when queried', async () => {
    const mockHealth: AIGatewayHealth = {
      status: 'ok',
      providers: [
        { name: 'groq', configured: true, model: 'test', healthy: true },
        { name: 'gemini', configured: true, model: 'test', healthy: false, error: 'Quota exceeded' }
      ],
      timestamp: new Date().toISOString(),
      uptimeMs: 1000
    };

    fetch.mockResolvedValueOnce({
      ok: true,
      json: async () => mockHealth
    } as Response);

    await service.checkHealth();

    const groqStatus = service.getProviderStatus('groq');
    expect(groqStatus).not.toBeUndefined();
    if (groqStatus) {
      expect(groqStatus.name).toBe('groq');
      expect(groqStatus.healthy).toBe(true);
    }

    const geminiStatus = service.getProviderStatus('gemini');
    expect(geminiStatus).not.toBeUndefined();
    if (geminiStatus) {
      expect(geminiStatus.name).toBe('gemini');
      expect(geminiStatus.healthy).toBe(false);
      expect(geminiStatus.error).toBe('Quota exceeded');
    }

    const unknownStatus = service.getProviderStatus('unknown');
    expect(unknownStatus).toBeUndefined();
  });

  it('should report healthy when last health is ok', async () => {
    const mockHealth: AIGatewayHealth = {
      status: 'ok',
      providers: [{ name: 'groq', configured: true, model: 'test', healthy: true }],
      timestamp: new Date().toISOString(),
      uptimeMs: 1000
    };

    fetch.mockResolvedValueOnce({
      ok: true,
      json: async () => mockHealth
    } as Response);

    await service.checkHealth();
    expect(service.isHealthy()).toBe(true);

    // Simulate unhealthy
    const unhealthyHealth: AIGatewayHealth = {
      status: 'error',
      providers: [],
      timestamp: new Date().toISOString(),
      uptimeMs: 0
    };
    service['lastHealth'] = unhealthyHealth;
    expect(service.isHealthy()).toBe(false);
  });
});