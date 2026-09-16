// SPDX-License-Identifier: Apache-2.0

import { logger } from '../utils/logger.js';
import { sleep } from '../shared/deferred-session-end.js';

export interface AIProviderStatus {
  name: string;
  configured: boolean;
  model: string;
  healthy: boolean;
  latencyMs?: number;
  error?: string;
}

export interface AIGatewayHealth {
  status: 'ok' | 'degraded' | 'error';
  providers: AIProviderStatus[];
  timestamp: string;
  uptimeMs: number;
}

export class AIGatewayHealthService {
  private readonly gatewayUrl: string;
  private readonly pollIntervalMs: number;
  private lastHealth: AIGatewayHealth | null = null;
  private pollingInterval: NodeJS.Timeout | null = null;
  private isPolling = false;

  constructor(
    gatewayUrl: string = 'http://127.0.0.1:37778',
    pollIntervalMs: number = 30000 // 30 seconds default
  ) {
    this.gatewayUrl = gatewayUrl;
    this.pollIntervalMs = pollIntervalMs;
  }

  async start(): Promise<void> {
    if (this.isPolling) {
      return;
    }
    
    this.isPolling = true;
    // Perform initial health check
    await this.checkHealth();
    
    // Start periodic polling
    this.pollingInterval = setInterval(async () => {
      await this.checkHealth();
    }, this.pollIntervalMs);
    
    logger.info('AI-GATEWAY-HEALTH', `Started monitoring AI gateway at ${this.gatewayUrl}`);
  }

  async stop(): Promise<void> {
    if (!this.isPolling) {
      return;
    }
    
    this.isPolling = false;
    if (this.pollingInterval) {
      clearInterval(this.pollingInterval);
      this.pollingInterval = null;
    }
    
    logger.info('AI-GATEWAY-HEALTH', 'Stopped AI gateway health monitoring');
  }

  async checkHealth(): Promise<AIGatewayHealth> {
    const startTime = Date.now();
    
    try {
      const response = await fetch(`${this.gatewayUrl}/health`, {
        timeout: 5000 // 5 second timeout
      });
      
      const latencyMs = Date.now() - startTime;
      
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      
      const data = await response.json() as AIGatewayHealth;
      
      // Enhance with latency information
      const enhancedHealth: AIGatewayHealth = {
        ...data,
        providers: data.providers.map(provider => ({
          ...provider,
          latencyMs: Math.round(latencyMs / data.providers.length) // Distribute latency evenly
        }))
      };
      
      this.lastHealth = enhancedHealth;
      return enhancedHealth;
    } catch (error) {
      const errorHealth: AIGatewayHealth = {
        status: 'error',
        providers: [],
        timestamp: new Date().toISOString(),
        uptimeMs: 0
      };
      
      // If we have last known good state, use it but mark as degraded
      if (this.lastHealth) {
        errorHealth.providers = this.lastHealth.providers.map(provider => ({
          ...provider,
          healthy: false,
          error: (error as Error).message
        }));
        errorHealth.status = 'degraded';
      }
      
      this.lastHealth = errorHealth;
      logger.warn('AI-GATEWAY-HEALTH', `Failed to check AI gateway health: ${(error as Error).message}`);
      return errorHealth;
    }
  }

  getLastHealth(): AIGatewayHealth | null {
    return this.lastHealth;
  }

  isHealthy(): boolean {
    return this.lastHealth?.status === 'ok';
  }

  getProviderStatus(providerName: string): AIProviderStatus | undefined {
    return this.lastHealth?.providers.find(p => p.name === providerName);
  }
}