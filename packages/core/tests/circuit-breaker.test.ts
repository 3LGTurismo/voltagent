/**
 * Unit Tests for Circuit Breaker
 *
 * Run with: npx vitest run tests/circuit-breaker.test.ts
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  CircuitBreaker,
  CircuitBreakerOpenError,
  CircuitBreakerRegistry,
  CircuitState,
  createA2aCircuitBreaker,
  createHttpCircuitBreaker,
  createMcpCircuitBreaker,
} from "../resilience/circuit-breaker";

describe("CircuitBreaker", () => {
  let breaker: CircuitBreaker;

  beforeEach(() => {
    breaker = new CircuitBreaker({
      failureThreshold: 3,
      resetTimeout: 1000,
      successThreshold: 2,
      name: "test-breaker",
    });
  });

  describe("Initial State", () => {
    it("should start in CLOSED state", () => {
      expect(breaker.stateName).toBe(CircuitState.CLOSED);
      expect(breaker.isClosed()).toBe(true);
      expect(breaker.isOpen()).toBe(false);
      expect(breaker.isHalfOpen()).toBe(false);
    });

    it("should have zero failures and successes", () => {
      const stats = breaker.stats;
      expect(stats.failures).toBe(0);
      expect(stats.successes).toBe(0);
      expect(stats.state).toBe(CircuitState.CLOSED);
    });
  });

  describe("Successful Execution", () => {
    it("should execute function and return result", async () => {
      const result = await breaker.execute(async () => "success");
      expect(result).toBe("success");
    });

    it("should reset failure count on success in CLOSED state", async () => {
      // Cause some failures
      for (let i = 0; i < 2; i++) {
        try {
          await breaker.execute(async () => {
            throw new Error("fail");
          });
        } catch {}
      }
      expect(breaker.stats.failures).toBe(2);

      // Success should reset failures
      await breaker.execute(async () => "success");
      expect(breaker.stats.failures).toBe(0);
    });
  });

  describe("Failure Handling", () => {
    it("should increment failure count on error", async () => {
      try {
        await breaker.execute(async () => {
          throw new Error("fail");
        });
      } catch {}

      expect(breaker.stats.failures).toBe(1);
      expect(breaker.stats.lastFailure).toBeInstanceOf(Date);
    });

    it("should open circuit after failure threshold", async () => {
      for (let i = 0; i < 3; i++) {
        try {
          await breaker.execute(async () => {
            throw new Error("fail");
          });
        } catch {}
      }

      expect(breaker.stateName).toBe(CircuitState.OPEN);
      expect(breaker.isOpen()).toBe(true);
    });

    it("should throw CircuitBreakerOpenError when open", async () => {
      // Open the circuit
      for (let i = 0; i < 3; i++) {
        try {
          await breaker.execute(async () => {
            throw new Error("fail");
          });
        } catch {}
      }

      // Next call should fail fast
      await expect(breaker.execute(async () => "success")).rejects.toThrow(CircuitBreakerOpenError);
    });

    it("should not count excluded errors as failures", async () => {
      const breakerWithExclude = new CircuitBreaker({
        failureThreshold: 2,
        excludeErrors: [TypeError],
        name: "exclude-test",
      });

      // TypeError should not count
      try {
        await breakerWithExclude.execute(async () => {
          throw new TypeError("network error");
        });
      } catch {}

      expect(breakerWithExclude.stats.failures).toBe(0);
      expect(breakerWithExclude.stateName).toBe(CircuitState.CLOSED);
    });
  });

  describe("Half-Open State", () => {
    it("should transition to HALF_OPEN after resetTimeout", async () => {
      const fastBreaker = new CircuitBreaker({
        failureThreshold: 2,
        resetTimeout: 50, // 50ms
        successThreshold: 2,
        name: "fast-breaker",
      });

      // Open the circuit
      for (let i = 0; i < 2; i++) {
        try {
          await fastBreaker.execute(async () => {
            throw new Error("fail");
          });
        } catch {}
      }
      expect(fastBreaker.stateName).toBe(CircuitState.OPEN);

      // Wait for reset timeout
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Should be half-open now
      expect(fastBreaker.stateName).toBe(CircuitState.HALF_OPEN);
    });

    it("should close circuit after successThreshold successes in HALF_OPEN", async () => {
      const fastBreaker = new CircuitBreaker({
        failureThreshold: 1,
        resetTimeout: 50,
        successThreshold: 2,
        name: "half-open-test",
      });

      // Open
      try {
        await fastBreaker.execute(async () => {
          throw new Error("fail");
        });
      } catch {}
      expect(fastBreaker.stateName).toBe(CircuitState.OPEN);

      // Wait for half-open
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(fastBreaker.stateName).toBe(CircuitState.HALF_OPEN);

      // Two successes should close
      await fastBreaker.execute(async () => "success");
      expect(fastBreaker.stateName).toBe(CircuitState.HALF_OPEN);

      await fastBreaker.execute(async () => "success");
      expect(fastBreaker.stateName).toBe(CircuitState.CLOSED);
    });

    it("should reopen on failure in HALF_OPEN", async () => {
      const fastBreaker = new CircuitBreaker({
        failureThreshold: 1,
        resetTimeout: 50,
        successThreshold: 2,
        name: "half-open-fail",
      });

      // Open
      try {
        await fastBreaker.execute(async () => {
          throw new Error("fail");
        });
      } catch {}

      // Wait for half-open
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(fastBreaker.stateName).toBe(CircuitState.HALF_OPEN);

      // Failure should reopen
      try {
        await fastBreaker.execute(async () => {
          throw new Error("fail");
        });
      } catch {}
      expect(fastBreaker.stateName).toBe(CircuitState.OPEN);
    });
  });

  describe("Manual Controls", () => {
    it("should reset manually", async () => {
      // Open the circuit
      for (let i = 0; i < 3; i++) {
        try {
          await breaker.execute(async () => {
            throw new Error("fail");
          });
        } catch {}
      }
      expect(breaker.isOpen()).toBe(true);

      breaker.reset();
      expect(breaker.isClosed()).toBe(true);
      expect(breaker.stats.failures).toBe(0);
    });

    it("should force open manually", () => {
      expect(breaker.isClosed()).toBe(true);
      breaker.forceOpen();
      expect(breaker.isOpen()).toBe(true);
    });
  });

  describe("Listeners", () => {
    it("should notify listeners on state change", async () => {
      const listener = vi.fn();
      const unsubscribe = breaker.addListener(listener);

      // Trigger state change
      await breaker.execute(async () => {
        throw new Error("fail");
      });

      expect(listener).toHaveBeenCalledWith(CircuitState.CLOSED); // Still closed (1 failure)

      // Open it
      for (let i = 0; i < 2; i++) {
        try {
          await breaker.execute(async () => {
            throw new Error("fail");
          });
        } catch {}
      }

      expect(listener).toHaveBeenCalledWith(CircuitState.OPEN);

      unsubscribe();
      listener.mockClear();

      breaker.reset();
      expect(listener).not.toHaveBeenCalled();
    });
  });

  describe("Sync Execution", () => {
    it("should execute sync functions", () => {
      const result = breaker.executeSync(() => "sync result");
      expect(result).toBe("sync result");
    });

    it("should throw on sync error", () => {
      expect(() => {
        breaker.executeSync(() => {
          throw new Error("sync fail");
        });
      }).toThrow("sync fail");
    });
  });
});

describe("CircuitBreakerRegistry", () => {
  beforeEach(() => {
    // Reset singleton for clean tests
    (CircuitBreakerRegistry as any).instance = undefined;
  });

  it("should create and retrieve breakers", () => {
    const registry = CircuitBreakerRegistry.getInstance();

    const breaker1 = registry.getOrCreate("test-1", { failureThreshold: 5 });
    const breaker2 = registry.getOrCreate("test-2", { failureThreshold: 10 });

    expect(breaker1).toBeInstanceOf(CircuitBreaker);
    expect(breaker2).toBeInstanceOf(CircuitBreaker);
    expect(breaker1).not.toBe(breaker2);
  });

  it("should return same instance for same name", () => {
    const registry = CircuitBreakerRegistry.getInstance();

    const breaker1 = registry.getOrCreate("same-name", { failureThreshold: 5 });
    const breaker2 = registry.getOrCreate("same-name", { failureThreshold: 10 });

    expect(breaker1).toBe(breaker2);
  });

  it("should get all stats", () => {
    const registry = CircuitBreakerRegistry.getInstance();

    registry.getOrCreate("stats-test-1");
    registry.getOrCreate("stats-test-2");

    const stats = registry.getAllStats();
    expect(stats["stats-test-1"]).toBeDefined();
    expect(stats["stats-test-2"]).toBeDefined();
    expect(stats["stats-test-1"].state).toBe(CircuitState.CLOSED);
  });

  it("should reset all breakers", () => {
    const registry = CircuitBreakerRegistry.getInstance();

    const breaker = registry.getOrCreate("reset-test");
    breaker.forceOpen();
    expect(breaker.isOpen()).toBe(true);

    registry.resetAll();
    expect(breaker.isClosed()).toBe(true);
  });
});

describe("Factory Functions", () => {
  beforeEach(() => {
    (CircuitBreakerRegistry as any).instance = undefined;
  });

  it("should create MCP circuit breaker with correct defaults", () => {
    const breaker = createMcpCircuitBreaker("test-server");

    expect(breaker).toBeInstanceOf(CircuitBreaker);
    expect(breaker.stats.failures).toBe(0);
  });

  it("should create A2A circuit breaker with correct defaults", () => {
    const breaker = createA2aCircuitBreaker("test-server");

    expect(breaker).toBeInstanceOf(CircuitBreaker);
  });

  it("should create HTTP circuit breaker with correct defaults", () => {
    const breaker = createHttpCircuitBreaker("test-api");

    expect(breaker).toBeInstanceOf(CircuitBreaker);
    // HTTP breaker should exclude TypeError (network errors)
    expect(breaker.options.excludeErrors).toContain(TypeError);
  });

  it("should reuse breakers for same name", () => {
    const breaker1 = createHttpCircuitBreaker("same-api");
    const breaker2 = createHttpCircuitBreaker("same-api");

    expect(breaker1).toBe(breaker2);
  });
});

describe("CircuitBreakerOpenError", () => {
  it("should have correct name and message", () => {
    const error = new CircuitBreakerOpenError("test-circuit");

    expect(error.name).toBe("CircuitBreakerOpenError");
    expect(error.message).toContain("test-circuit");
    expect(error.message).toContain("OPEN");
    expect(error.circuitName).toBe("test-circuit");
  });
});
