/**
 * Integration Test for PostgresStorageAdapter
 *
 * Run with: npx vitest run tests/postgres-storage-adapter.test.ts
 * Requires DATABASE_URL pointing to crm_ai database with migrations applied
 */

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  PostgresStorageAdapter,
  createPostgresStorageAdapter,
} from "../memory/adapters/storage/postgres";

// Skip if no DATABASE_URL (e.g., in CI without database)
const hasDatabase = !!process.env.DATABASE_URL;

(hasDatabase ? describe : describe.skip)("PostgresStorageAdapter Integration", () => {
  let adapter: PostgresStorageAdapter;
  const testUserId = "test-user-integration";
  const testConversationId = "test-conv-integration";

  beforeAll(async () => {
    adapter = createPostgresStorageAdapter();
    await adapter.initialize();
  });

  afterAll(async () => {
    await adapter.close();
  });

  it("should create and retrieve a conversation", async () => {
    const conversation = await adapter.createConversation({
      id: testConversationId,
      userId: testUserId,
      resourceId: testUserId,
      title: "Test Conversation",
      metadata: { source: "integration-test" },
    });

    expect(conversation.id).toBe(testConversationId);
    expect(conversation.userId).toBe(testUserId);
    expect(conversation.title).toBe("Test Conversation");
    expect(conversation.metadata).toEqual({ source: "integration-test" });
    expect(conversation.createdAt).toBeInstanceOf(Date);
    expect(conversation.updatedAt).toBeInstanceOf(Date);
  });

  it("should get the created conversation", async () => {
    const conversation = await adapter.getConversation(testConversationId);

    expect(conversation).not.toBeNull();
    expect(conversation?.id).toBe(testConversationId);
    expect(conversation?.title).toBe("Test Conversation");
  });

  it("should add and retrieve messages", async () => {
    const messages = [
      {
        id: "msg-1",
        role: "user" as const,
        content: "Olá, quero viajar para Fernando de Noronha",
      },
      {
        id: "msg-2",
        role: "assistant" as const,
        content: "Ótimo! Para qual período você gostaria de viajar?",
      },
    ];

    await adapter.addMessages(messages, testUserId, testConversationId);

    const retrieved = await adapter.getMessages(testUserId, testConversationId, { limit: 10 });

    expect(retrieved.length).toBe(2);
    expect(retrieved[0].content).toBe("Olá, quero viajar para Fernando de Noronha");
    expect(retrieved[1].content).toBe("Ótimo! Para qual período você gostaria de viajar?");
  });

  it("should update conversation", async () => {
    const updated = await adapter.updateConversation(testConversationId, {
      title: "Updated Title",
      metadata: { source: "integration-test", updated: true },
    });

    expect(updated.title).toBe("Updated Title");
    expect(updated.metadata).toEqual({ source: "integration-test", updated: true });
  });

  it("should handle working memory", async () => {
    // Set working memory
    await adapter.setWorkingMemory({
      userId: testUserId,
      conversationId: testConversationId,
      scope: "conversation",
      content: "Cliente quer Noronha, 2 adultos, dezembro",
    });

    // Get working memory
    const memory = await adapter.getWorkingMemory({
      userId: testUserId,
      conversationId: testConversationId,
      scope: "conversation",
    });

    expect(memory).toBe("Cliente quer Noronha, 2 adultos, dezembro");
  });

  it("should handle workflow states", async () => {
    const executionId = "test-execution-123";
    const workflowState = {
      executionId,
      workflowId: "travel-booking-workflow",
      status: "running" as const,
      stepId: "search-packages",
      state: { currentStep: "search", packagesFound: 5 },
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    await adapter.setWorkflowState(executionId, workflowState);
    const retrieved = await adapter.getWorkflowState(executionId);

    expect(retrieved).not.toBeNull();
    expect(retrieved?.executionId).toBe(executionId);
    expect(retrieved?.workflowId).toBe("travel-booking-workflow");
    expect(retrieved?.status).toBe("running");
    expect(retrieved?.state).toEqual({ currentStep: "search", packagesFound: 5 });
  });

  it("should query conversations by user", async () => {
    const conversations = await adapter.getConversationsByUserId(testUserId, { limit: 10 });

    expect(conversations.length).toBeGreaterThan(0);
    const testConv = conversations.find((c) => c.id === testConversationId);
    expect(testConv).toBeDefined();
    expect(testConv?.title).toBe("Updated Title");
  });

  it("should count conversations", async () => {
    const count = await adapter.countConversations({ userId: testUserId });
    expect(count).toBeGreaterThanOrEqual(1);
  });

  it("should delete messages", async () => {
    // Add a message to delete
    await adapter.addMessage(
      { id: "msg-to-delete", role: "user", content: "To be deleted" },
      testUserId,
      testConversationId,
    );

    // Delete it
    await adapter.deleteMessages(["msg-to-delete"], testUserId, testConversationId);

    // Verify it's gone
    const messages = await adapter.getMessages(testUserId, testConversationId, { limit: 100 });
    const deleted = messages.find((m) => m.id === "msg-to-delete");
    expect(deleted).toBeUndefined();
  });

  it("should clear all messages for user", async () => {
    await adapter.addMessage(
      { id: "msg-clear-1", role: "user", content: "Clear test 1" },
      testUserId,
      testConversationId,
    );

    await adapter.clearMessages(testUserId, testConversationId);

    const messages = await adapter.getMessages(testUserId, testConversationId, { limit: 100 });
    expect(messages.length).toBe(0);
  });
});

// Unit tests (no database required)
describe("PostgresStorageAdapter Unit Tests", () => {
  it("should create adapter with default options", () => {
    const adapter = new PostgresStorageAdapter();
    expect(adapter).toBeInstanceOf(PostgresStorageAdapter);
    expect(adapter.isInitialized()).toBe(false);
  });

  it("should create adapter with custom table prefix", () => {
    const adapter = new PostgresStorageAdapter({ tablePrefix: "custom_" });
    expect(adapter).toBeInstanceOf(PostgresStorageAdapter);
  });

  it("should create adapter with provided pool", () => {
    const mockPool = {} as any;
    const adapter = new PostgresStorageAdapter({ pool: mockPool });
    expect(adapter.getPool()).toBe(mockPool);
  });

  it("should throw on duplicate conversation", async () => {
    const _adapter = new PostgresStorageAdapter();
    // Mock the pool to simulate unique violation
    const mockPool = {
      query: vi
        .fn()
        .mockResolvedValueOnce({ rows: [{ id: "test", user_id: "user" }] }) // createConversation
        .mockRejectedValueOnce({ code: "23505" }), // duplicate
      connect: vi.fn().mockResolvedValue({
        query: vi.fn(),
        release: vi.fn(),
      }),
    };

    const adapterWithMock = new PostgresStorageAdapter({ pool: mockPool as any });

    await expect(
      adapterWithMock.createConversation({ userId: "user", id: "test" }),
    ).rejects.toThrow();
  });
});
