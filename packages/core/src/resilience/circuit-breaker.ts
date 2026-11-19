/**
 * Circuit Breaker Implementation for VoltAgent
 *
 * Based on the pybreaker pattern used in nodus-teste.
 * Provides fault tolerance for external service calls (MCP, A2A, HTTP APIs).
 *
 * States:
 * - CLOSED: Normal operation, requests pass through
 * - OPEN: Circuit is open, requests fail fast
 * - HALF_OPEN: Testing if service recovered, limited requests allowed
 */

export enum CircuitState {
  CLOSED = "CLOSED",
  OPEN = "OPEN",
  HALF_OPEN = "HALF_OPEN",
}

// TimeoutError is a Node.js built-in but not in TypeScript's default lib
// Use a type-safe reference that satisfies ErrorConstructor
const TimeoutErrorCtor: ErrorConstructor =
  (globalThis as any).TimeoutError ??
  class TimeoutError extends Error {
    constructor(message?: string) {
      super(message ?? "Timeout");
      this.name = "TimeoutError";
    }
    static isError(value: unknown): value is Error {
      return value instanceof Error;
    }
    static captureStackTrace = Error.captureStackTrace;
    static prepareStackTrace = Error.prepareStackTrace;
    static stackTraceLimit = Error.stackTraceLimit;
  };

export interface CircuitBreakerOptions {
  /** Number of failures before opening circuit */
  failureThreshold?: number;
  /** Time in ms before attempting half-open */
  resetTimeout?: number;
  /** Number of successful requests in half-open before closing */
  successThreshold?: number;
  /** Errors that should NOT count as failures */
  excludeErrors?: ErrorConstructor[];
  /** Called when circuit opens */
  onOpen?: () => void;
  /** Called when circuit closes */
  onClose?: () => void;
  /** Called when circuit enters half-open */
  onHalfOpen?: () => void;
  /** Custom name for logging/metrics */
  name?: string;
}

export interface CircuitBreakerStats {
  state: CircuitState;
  failures: number;
  successes: number;
  lastFailure?: Date;
  lastSuccess?: Date;
  nextAttempt?: Date;
}

type Listener = (state: CircuitState) => void;

/**
 * Circuit Breaker class
 *
 * Usage:
 *   const breaker = new CircuitBreaker({
 *     failureThreshold: 5,
 *     resetTimeout: 30000,
 *     name: 'mcp-server',
 *   });
 *
 *   const result = await breaker.execute(async () => {
 *     return await mcpClient.callTool('search', params);
 *   });
 */
export class CircuitBreaker {
  private state: CircuitState = CircuitState.CLOSED;
  private failures = 0;
  private successes = 0;
  private lastFailure?: Date;
  private lastSuccess?: Date;
  private nextAttempt?: Date;
  private readonly listeners: Set<Listener> = new Set();

  constructor(private readonly options: CircuitBreakerOptions = {}) {
    this.options = {
      failureThreshold: options.failureThreshold ?? 5,
      resetTimeout: options.resetTimeout ?? 30000,
      successThreshold: options.successThreshold ?? 2,
      excludeErrors: options.excludeErrors ?? [TimeoutErrorCtor],
      ...options,
    };
  }

  get name(): string {
    return this.options.name ?? "circuit-breaker";
  }

  get stateName(): CircuitState {
    // Auto-transition from OPEN to HALF_OPEN after resetTimeout
    if (
      this.state === CircuitState.OPEN &&
      this.nextAttempt &&
      Date.now() >= this.nextAttempt.getTime()
    ) {
      this.transitionToHalfOpen();
    }
    return this.state;
  }

  get stats(): CircuitBreakerStats {
    return {
      state: this.stateName,
      failures: this.failures,
      successes: this.successes,
      lastFailure: this.lastFailure,
      lastSuccess: this.lastSuccess,
      nextAttempt: this.nextAttempt,
    };
  }

  isClosed(): boolean {
    return this.stateName === CircuitState.CLOSED;
  }

  isOpen(): boolean {
    return this.stateName === CircuitState.OPEN;
  }

  isHalfOpen(): boolean {
    return this.stateName === CircuitState.HALF_OPEN;
  }

  addListener(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notifyListeners(): void {
    for (const listener of this.listeners) {
      try {
        listener(this.state);
      } catch {
        // Ignore listener errors
      }
    }
  }

  private transitionToOpen(): void {
    this.state = CircuitState.OPEN;
    const resetTimeout = this.options.resetTimeout ?? 30000;
    this.nextAttempt = new Date(Date.now() + resetTimeout);
    this.notifyListeners();
    this.options.onOpen?.();
  }

  private transitionToHalfOpen(): void {
    this.state = CircuitState.HALF_OPEN;
    this.successes = 0;
    this.notifyListeners();
    this.options.onHalfOpen?.();
  }

  private transitionToClosed(): void {
    this.state = CircuitState.CLOSED;
    this.failures = 0;
    this.successes = 0;
    this.nextAttempt = undefined;
    this.notifyListeners();
    this.options.onClose?.();
  }

  private shouldCountAsFailure(error: unknown): boolean {
    if (!this.options.excludeErrors) return true;
    return !this.options.excludeErrors.some((E) => error instanceof E);
  }

  /**
   * Execute a function with circuit breaker protection
   */
  async execute<T>(fn: () => Promise<T>): Promise<T> {
    // Check if circuit is open
    if (this.stateName === CircuitState.OPEN) {
      const error = new CircuitBreakerOpenError(this.name);
      throw error;
    }

    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (error) {
      this.onFailure(error);
      throw error;
    }
  }

  /**
   * Execute a function with circuit breaker protection (sync version)
   */
  executeSync<T>(fn: () => T): T {
    if (this.stateName === CircuitState.OPEN) {
      throw new CircuitBreakerOpenError(this.name);
    }

    try {
      const result = fn();
      this.onSuccess();
      return result;
    } catch (error) {
      this.onFailure(error);
      throw error;
    }
  }

  private onSuccess(): void {
    this.lastSuccess = new Date();

    if (this.state === CircuitState.HALF_OPEN) {
      this.successes++;
      const successThreshold = this.options.successThreshold ?? 2;
      if (this.successes >= successThreshold) {
        this.transitionToClosed();
      }
    } else if (this.state === CircuitState.CLOSED) {
      // Reset failure count on success in closed state
      this.failures = 0;
    }
  }

  private onFailure(error: unknown): void {
    if (!this.shouldCountAsFailure(error)) {
      return; // Don't count excluded errors
    }

    this.lastFailure = new Date();
    this.failures++;

    if (this.state === CircuitState.HALF_OPEN) {
      // Any failure in half-open goes back to open
      this.transitionToOpen();
    } else if (
      this.state === CircuitState.CLOSED &&
      this.failures >= (this.options.failureThreshold ?? 5)
    ) {
      this.transitionToOpen();
    }
  }

  /** Manually reset the circuit breaker */
  reset(): void {
    this.transitionToClosed();
  }

  /** Manually force open the circuit */
  forceOpen(): void {
    this.transitionToOpen();
  }
}

/**
 * Error thrown when circuit breaker is open
 */
export class CircuitBreakerOpenError extends Error {
  constructor(public readonly circuitName: string) {
    super(`Circuit breaker "${circuitName}" is OPEN - failing fast`);
    this.name = "CircuitBreakerOpenError";
  }
}

/**
 * Circuit Breaker Registry for managing multiple breakers
 *
 * Usage:
 *   const registry = CircuitBreakerRegistry.getInstance();
 *   const breaker = registry.getOrCreate('mcp-server', { failureThreshold: 5 });
 *   await breaker.execute(() => mcpClient.call(...));
 */
export class CircuitBreakerRegistry {
  private static instance: CircuitBreakerRegistry;
  private breakers: Map<string, CircuitBreaker> = new Map();

  static getInstance(): CircuitBreakerRegistry {
    if (!CircuitBreakerRegistry.instance) {
      CircuitBreakerRegistry.instance = new CircuitBreakerRegistry();
    }
    return CircuitBreakerRegistry.instance;
  }

  getOrCreate(name: string, options?: CircuitBreakerOptions): CircuitBreaker {
    let breaker = this.breakers.get(name);
    if (!breaker) {
      breaker = new CircuitBreaker({ ...options, name });
      this.breakers.set(name, breaker);
    }
    return breaker;
  }

  get(name: string): CircuitBreaker | undefined {
    return this.breakers.get(name);
  }

  remove(name: string): boolean {
    return this.breakers.delete(name);
  }

  getAllStats(): Record<string, CircuitBreakerStats> {
    const stats: Record<string, CircuitBreakerStats> = {};
    for (const [name, breaker] of this.breakers) {
      stats[name] = breaker.stats;
    }
    return stats;
  }

  resetAll(): void {
    for (const breaker of this.breakers.values()) {
      breaker.reset();
    }
  }
}

/**
 * Helper to create a circuit breaker for MCP server calls
 */
export function createMcpCircuitBreaker(serverName: string): CircuitBreaker {
  return CircuitBreakerRegistry.getInstance().getOrCreate(`mcp-${serverName}`, {
    failureThreshold: 5,
    resetTimeout: 30000,
    successThreshold: 2,
    name: `mcp-${serverName}`,
  });
}

/**
 * Helper to create a circuit breaker for A2A server calls
 */
export function createA2aCircuitBreaker(serverName: string): CircuitBreaker {
  return CircuitBreakerRegistry.getInstance().getOrCreate(`a2a-${serverName}`, {
    failureThreshold: 5,
    resetTimeout: 30000,
    successThreshold: 2,
    name: `a2a-${serverName}`,
  });
}

/**
 * Helper to create a circuit breaker for HTTP API calls
 */
export function createHttpCircuitBreaker(serviceName: string): CircuitBreaker {
  return CircuitBreakerRegistry.getInstance().getOrCreate(`http-${serviceName}`, {
    failureThreshold: 10,
    resetTimeout: 60000,
    successThreshold: 3,
    name: `http-${serviceName}`,
    excludeErrors: [TimeoutErrorCtor, TypeError], // Network errors don't count
  });
}
