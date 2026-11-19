/**
 * PostgreSQL Storage Adapter for VoltAgent Memory V2
 *
 * Uses the same PostgreSQL database as the nodus-teste CRM (crm_ai database).
 * Enables shared memory between VoltAgent agents and Python Hermes services.
 *
 * Tables used:
 * - voltagent_conversations
 * - voltagent_messages
 * - voltagent_workflow_states
 * - voltagent_working_memory
 * - voltagent_conversation_steps
 * - voltagent_users
 *
 * Requires migration to create these tables.
 *
 * NOTE: This adapter is temporarily disabled pending type fixes to match the
 * StorageAdapter interface. The types have significant mismatches that need
 * to be resolved before it can be enabled.
 */

import { randomUUID } from "@voltagent/internal/utils";
import type { UIMessage } from "ai";
import { Pool, type PoolConfig, QueryResult } from "pg";
import type { OperationContext } from "../../../agent/types";
import { ConversationAlreadyExistsError, ConversationNotFoundError } from "../../errors";
import type {
  Conversation,
  ConversationQueryOptions,
  ConversationStepRecord,
  CreateConversationInput,
  GetConversationStepsOptions,
  GetMessagesOptions,
  StorageAdapter,
  StoredUIMessage,
  WorkflowRunQuery,
  WorkflowStateEntry,
  WorkingMemoryScope,
} from "../../types";

interface _UserInfo {
  id: string;
  metadata?: Record<string, unknown>;
  created_at: Date;
  updated_at: Date;
}

function _areMetadataValuesEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (typeof left !== "object" || left === null || typeof right !== "object" || right === null)
    return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    for (let i = 0; i < left.length; i++) {
      if (!areMetadataValuesEqual(left[i], right[i])) return false;
    }
    return true;
  }
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord);
  const rightKeys = Object.keys(rightRecord);
  if (leftKeys.length !== rightKeys.length) return false;
  for (const key of leftKeys) {
    if (!Object.prototype.hasOwnProperty.call(rightRecord, key)) return false;
    if (!areMetadataValuesEqual(leftRecord[key], rightRecord[key])) return false;
  }
  return true;
}

function mapConversationRow(row: any): Conversation {
  return {
    id: row.id,
    resourceId: row.resource_id,
    title: row.title,
    userId: row.user_id,
    metadata: row.metadata ?? {},
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function _mapStoredMessage(row: any): StoredUIMessage {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    userId: row.user_id,
    role: row.role,
    content: row.content,
    parts: row.parts,
    annotations: row.annotations,
    createdAt: row.created_at,
  };
}

function mapWorkflowStateRow(row: any): WorkflowStateEntry {
  return {
    executionId: row.execution_id,
    workflowId: row.workflow_id,
    status: row.status,
    stepId: row.step_id,
    state: row.state,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    suspendedAt: row.suspended_at,
    resumeData: row.resume_data,
  };
}

export interface PostgresStorageAdapterOptions {
  /** Database connection pool (optional - will create if not provided) */
  pool?: Pool;
  /** Connection string (used if pool not provided) */
  connectionString?: string;
  /** Pool configuration */
  poolConfig?: PoolConfig;
  /** Table prefix (default: 'voltagent_') */
  tablePrefix?: string;
  /** Auto-create tables on init (default: false - run migrations instead) */
  autoCreateTables?: boolean;
}

/**
 * PostgreSQL Storage Adapter for Memory V2
 *
 * Implements StorageAdapter interface using PostgreSQL.
 * Shares database with nodus-teste CRM for unified memory.
 */
export class PostgresStorageAdapter implements StorageAdapter {
  private pool: Pool;
  private readonly tablePrefix: string;
  private initialized = false;

  constructor(options: PostgresStorageAdapterOptions = {}) {
    this.tablePrefix = options.tablePrefix ?? "voltagent_";

    if (options.pool) {
      this.pool = options.pool;
    } else {
      this.pool = new Pool(
        options.poolConfig ?? {
          connectionString:
            options.connectionString ??
            process.env.DATABASE_URL ??
            "postgresql://postgres:postgres@localhost:5432/crm_ai",
          max: 10,
          idleTimeoutMillis: 30000,
          connectionTimeoutMillis: 5000,
        },
      );
    }
  }

  /**
   * Initialize the adapter - create tables if needed
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    // Test connection
    const client = await this.pool.connect();
    try {
      await client.query("SELECT 1");
    } finally {
      client.release();
    }

    this.initialized = true;
  }

  /**
   * Get table name with prefix
   */
  private table(name: string): string {
    return `${this.tablePrefix}${name}`;
  }

  // ============================================================================
  // Message Operations
  // ============================================================================

  async addMessage(
    message: UIMessage,
    userId: string,
    conversationId: string,
    context?: OperationContext,
  ): Promise<void> {
    await this.addMessages([message], userId, conversationId, context);
  }

  async addMessages(
    messages: UIMessage[],
    userId: string,
    conversationId: string,
    _context?: OperationContext,
  ): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");

      for (const message of messages) {
        const id = message.id ?? randomUUID();
        const now = new Date();

        await client.query(
          `INSERT INTO ${this.table("messages")}
            (id, conversation_id, user_id, role, content, parts, annotations, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           ON CONFLICT (id) DO UPDATE SET
             content = EXCLUDED.content,
             parts = EXCLUDED.parts,
             annotations = EXCLUDED.annotations`,
          [
            id,
            conversationId,
            userId,
            message.role,
            typeof message.content === "string" ? message.content : JSON.stringify(message.content),
            message.parts ? JSON.stringify(message.parts) : null,
            message.annotations ? JSON.stringify(message.annotations) : null,
            now,
          ],
        );
      }

      // Update conversation updated_at
      await client.query(
        `UPDATE ${this.table("conversations")} SET updated_at = $1 WHERE id = $2`,
        [new Date(), conversationId],
      );

      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async getMessages(
    userId: string,
    conversationId: string,
    options?: GetMessagesOptions,
    _context?: OperationContext,
  ): Promise<UIMessage<{ createdAt: Date }>[]> {
    const limit = options?.limit ?? 100;
    const offset = options?.offset ?? 0;
    const order = options?.order ?? "asc";

    const result = await this.pool.query(
      `SELECT id, conversation_id, user_id, role, content, parts, annotations, created_at
       FROM ${this.table("messages")}
       WHERE user_id = $1 AND conversation_id = $2
       ORDER BY created_at ${order === "desc" ? "DESC" : "ASC"}
       LIMIT $3 OFFSET $4`,
      [userId, conversationId, limit, offset],
    );

    return result.rows.map((row) => ({
      id: row.id,
      role: row.role,
      content: row.content,
      parts: row.parts ? JSON.parse(row.parts) : undefined,
      annotations: row.annotations ? JSON.parse(row.annotations) : undefined,
      createdAt: row.created_at,
    }));
  }

  async clearMessages(
    userId: string,
    conversationId?: string,
    _context?: OperationContext,
  ): Promise<void> {
    if (conversationId) {
      await this.pool.query(
        `DELETE FROM ${this.table("messages")} WHERE user_id = $1 AND conversation_id = $2`,
        [userId, conversationId],
      );
    } else {
      await this.pool.query(`DELETE FROM ${this.table("messages")} WHERE user_id = $1`, [userId]);
    }
  }

  async deleteMessages(
    messageIds: string[],
    userId: string,
    conversationId: string,
    _context?: OperationContext,
  ): Promise<void> {
    if (messageIds.length === 0) return;

    const placeholders = messageIds.map((_, i) => `$${i + 3}`).join(", ");
    await this.pool.query(
      `DELETE FROM ${this.table("messages")}
       WHERE user_id = $1 AND conversation_id = $2 AND id IN (${placeholders})`,
      [userId, conversationId, ...messageIds],
    );
  }

  // ============================================================================
  // Conversation Operations
  // ============================================================================

  async createConversation(input: CreateConversationInput): Promise<Conversation> {
    const id = input.id ?? randomUUID();
    const now = new Date();

    try {
      const result = await this.pool.query(
        `INSERT INTO ${this.table("conversations")}
          (id, resource_id, title, user_id, metadata, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING *`,
        [
          id,
          input.resourceId ?? null,
          input.title ?? null,
          input.userId,
          JSON.stringify(input.metadata ?? {}),
          now,
          now,
        ],
      );

      return mapConversationRow(result.rows[0]);
    } catch (error: any) {
      if (error.code === "23505") {
        // unique_violation
        throw new ConversationAlreadyExistsError(id);
      }
      throw error;
    }
  }

  async getConversation(id: string): Promise<Conversation | null> {
    const result = await this.pool.query(
      `SELECT * FROM ${this.table("conversations")} WHERE id = $1`,
      [id],
    );

    if (result.rows.length === 0) return null;
    return mapConversationRow(result.rows[0]);
  }

  async getConversations(resourceId: string): Promise<Conversation[]> {
    const result = await this.pool.query(
      `SELECT * FROM ${this.table("conversations")}
       WHERE resource_id = $1
       ORDER BY updated_at DESC`,
      [resourceId],
    );

    return result.rows.map(mapConversationRow);
  }

  async getConversationsByUserId(
    userId: string,
    options?: Omit<ConversationQueryOptions, "userId">,
  ): Promise<Conversation[]> {
    const limit = options?.limit ?? 50;
    const offset = options?.offset ?? 0;
    const order = options?.order ?? "desc";

    const result = await this.pool.query(
      `SELECT * FROM ${this.table("conversations")}
       WHERE user_id = $1
       ORDER BY updated_at ${order === "desc" ? "DESC" : "ASC"}
       LIMIT $2 OFFSET $3`,
      [userId, limit, offset],
    );

    return result.rows.map(mapConversationRow);
  }

  async queryConversations(options: ConversationQueryOptions): Promise<Conversation[]> {
    const conditions: string[] = [];
    const params: any[] = [];
    let paramIndex = 1;

    if (options.userId) {
      conditions.push(`user_id = $${paramIndex++}`);
      params.push(options.userId);
    }
    if (options.resourceId) {
      conditions.push(`resource_id = $${paramIndex++}`);
      params.push(options.resourceId);
    }
    if (options.title) {
      conditions.push(`title ILIKE $${paramIndex++}`);
      params.push(`%${options.title}%`);
    }
    if (options.metadata) {
      conditions.push(`metadata @> $${paramIndex++}`);
      params.push(JSON.stringify(options.metadata));
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const limit = options.limit ?? 50;
    const offset = options.offset ?? 0;
    const order = options.order ?? "desc";

    params.push(limit, offset);

    const result = await this.pool.query(
      `SELECT * FROM ${this.table("conversations")}
       ${whereClause}
       ORDER BY updated_at ${order === "desc" ? "DESC" : "ASC"}
       LIMIT $${paramIndex++} OFFSET $${paramIndex}`,
      params,
    );

    return result.rows.map(mapConversationRow);
  }

  async countConversations(options: ConversationQueryOptions): Promise<number> {
    const conditions: string[] = [];
    const params: any[] = [];
    let paramIndex = 1;

    if (options.userId) {
      conditions.push(`user_id = $${paramIndex++}`);
      params.push(options.userId);
    }
    if (options.resourceId) {
      conditions.push(`resource_id = $${paramIndex++}`);
      params.push(options.resourceId);
    }
    if (options.title) {
      conditions.push(`title ILIKE $${paramIndex++}`);
      params.push(`%${options.title}%`);
    }
    if (options.metadata) {
      conditions.push(`metadata @> $${paramIndex++}`);
      params.push(JSON.stringify(options.metadata));
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    const result = await this.pool.query(
      `SELECT COUNT(*) FROM ${this.table("conversations")} ${whereClause}`,
      params,
    );

    return Number.parseInt(result.rows[0].count, 10);
  }

  async updateConversation(
    id: string,
    updates: Partial<Omit<Conversation, "id" | "createdAt" | "updatedAt">>,
  ): Promise<Conversation> {
    const setParts: string[] = [];
    const params: any[] = [id];
    let paramIndex = 2;

    if (updates.resourceId !== undefined) {
      setParts.push(`resource_id = $${paramIndex++}`);
      params.push(updates.resourceId);
    }
    if (updates.title !== undefined) {
      setParts.push(`title = $${paramIndex++}`);
      params.push(updates.title);
    }
    if (updates.metadata !== undefined) {
      setParts.push(`metadata = $${paramIndex++}`);
      params.push(JSON.stringify(updates.metadata));
    }

    if (setParts.length === 0) {
      const existing = await this.getConversation(id);
      if (!existing) throw new ConversationNotFoundError(id);
      return existing;
    }

    setParts.push(`updated_at = $${paramIndex++}`);
    params.push(new Date());

    const result = await this.pool.query(
      `UPDATE ${this.table("conversations")} SET ${setParts.join(", ")} WHERE id = $1 RETURNING *`,
      params,
    );

    if (result.rows.length === 0) {
      throw new ConversationNotFoundError(id);
    }

    return mapConversationRow(result.rows[0]);
  }

  async deleteConversation(id: string): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");

      // Delete messages first (foreign key)
      await client.query(`DELETE FROM ${this.table("messages")} WHERE conversation_id = $1`, [id]);

      // Delete conversation
      await client.query(`DELETE FROM ${this.table("conversations")} WHERE id = $1`, [id]);

      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async saveConversationSteps(steps: ConversationStepRecord[]): Promise<void> {
    if (steps.length === 0) return;

    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");

      for (const step of steps) {
        await client.query(
          `INSERT INTO ${this.table("conversation_steps")}
            (id, conversation_id, user_id, step_number, input, output, tool_calls, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           ON CONFLICT (id) DO UPDATE SET
             output = EXCLUDED.output,
             tool_calls = EXCLUDED.tool_calls`,
          [
            step.id,
            step.conversationId,
            step.userId,
            step.stepNumber,
            JSON.stringify(step.input),
            JSON.stringify(step.output),
            step.toolCalls ? JSON.stringify(step.toolCalls) : null,
            step.createdAt,
          ],
        );
      }

      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async getConversationSteps(
    userId: string,
    conversationId: string,
    options?: GetConversationStepsOptions,
  ): Promise<ConversationStepRecord[]> {
    const limit = options?.limit ?? 50;
    const offset = options?.offset ?? 0;
    const order = options?.order ?? "asc";

    const result = await this.pool.query(
      `SELECT * FROM ${this.table("conversation_steps")}
       WHERE user_id = $1 AND conversation_id = $2
       ORDER BY step_number ${order === "desc" ? "DESC" : "ASC"}
       LIMIT $3 OFFSET $4`,
      [userId, conversationId, limit, offset],
    );

    return result.rows.map((row) => ({
      id: row.id,
      conversationId: row.conversation_id,
      userId: row.user_id,
      stepNumber: row.step_number,
      input: JSON.parse(row.input),
      output: JSON.parse(row.output),
      toolCalls: row.tool_calls ? JSON.parse(row.tool_calls) : undefined,
      createdAt: row.created_at,
    }));
  }

  // ============================================================================
  // Working Memory Operations
  // ============================================================================

  async getWorkingMemory(params: {
    conversationId?: string;
    userId?: string;
    scope: WorkingMemoryScope;
  }): Promise<string | null> {
    const { conversationId, userId, scope } = params;

    if (!userId && !conversationId) return null;

    const result = await this.pool.query(
      `SELECT content FROM ${this.table("working_memory")}
       WHERE scope = $1 AND user_id = $2 AND conversation_id = $3`,
      [scope, userId ?? null, conversationId ?? null],
    );

    if (result.rows.length === 0) return null;
    return result.rows[0].content;
  }

  async setWorkingMemory(params: {
    conversationId?: string;
    userId?: string;
    content: string;
    scope: WorkingMemoryScope;
  }): Promise<void> {
    const { conversationId, userId, content, scope } = params;

    if (!userId && !conversationId) return;

    await this.pool.query(
      `INSERT INTO ${this.table("working_memory")}
        (scope, user_id, conversation_id, content, updated_at)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (scope, user_id, conversation_id) DO UPDATE SET
         content = EXCLUDED.content,
         updated_at = EXCLUDED.updated_at`,
      [scope, userId ?? null, conversationId ?? null, content, new Date()],
    );
  }

  async deleteWorkingMemory(params: {
    conversationId?: string;
    userId?: string;
    scope: WorkingMemoryScope;
  }): Promise<void> {
    const { conversationId, userId, scope } = params;

    if (!userId && !conversationId) return;

    await this.pool.query(
      `DELETE FROM ${this.table("working_memory")}
       WHERE scope = $1 AND user_id = $2 AND conversation_id = $3`,
      [scope, userId ?? null, conversationId ?? null],
    );
  }

  // ============================================================================
  // Workflow State Operations
  // ============================================================================

  async getWorkflowState(executionId: string): Promise<WorkflowStateEntry | null> {
    const result = await this.pool.query(
      `SELECT * FROM ${this.table("workflow_states")} WHERE execution_id = $1`,
      [executionId],
    );

    if (result.rows.length === 0) return null;
    return mapWorkflowStateRow(result.rows[0]);
  }

  async queryWorkflowRuns(query: WorkflowRunQuery): Promise<WorkflowStateEntry[]> {
    const conditions: string[] = [];
    const params: any[] = [];
    let paramIndex = 1;

    if (query.workflowId) {
      conditions.push(`workflow_id = $${paramIndex++}`);
      params.push(query.workflowId);
    }
    if (query.status) {
      conditions.push(`status = $${paramIndex++}`);
      params.push(query.status);
    }
    if (query.userId) {
      conditions.push(`state->>'userId' = $${paramIndex++}`);
      params.push(query.userId);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const limit = query.limit ?? 50;
    const offset = query.offset ?? 0;

    params.push(limit, offset);

    const result = await this.pool.query(
      `SELECT * FROM ${this.table("workflow_states")}
       ${whereClause}
       ORDER BY created_at DESC
       LIMIT $${paramIndex++} OFFSET $${paramIndex}`,
      params,
    );

    return result.rows.map(mapWorkflowStateRow);
  }

  async setWorkflowState(executionId: string, state: WorkflowStateEntry): Promise<void> {
    await this.pool.query(
      `INSERT INTO ${this.table("workflow_states")}
        (execution_id, workflow_id, status, step_id, state, created_at, updated_at, suspended_at, resume_data)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (execution_id) DO UPDATE SET
         workflow_id = EXCLUDED.workflow_id,
         status = EXCLUDED.status,
         step_id = EXCLUDED.step_id,
         state = EXCLUDED.state,
         updated_at = EXCLUDED.updated_at,
         suspended_at = EXCLUDED.suspended_at,
         resume_data = EXCLUDED.resume_data`,
      [
        executionId,
        state.workflowId,
        state.status,
        state.stepId ?? null,
        JSON.stringify(state.state),
        state.createdAt,
        state.updatedAt,
        state.suspendedAt ?? null,
        state.resumeData ? JSON.stringify(state.resumeData) : null,
      ],
    );
  }

  async updateWorkflowState(
    executionId: string,
    updates: Partial<WorkflowStateEntry>,
  ): Promise<void> {
    const setParts: string[] = [];
    const params: any[] = [executionId];
    let paramIndex = 2;

    if (updates.workflowId !== undefined) {
      setParts.push(`workflow_id = $${paramIndex++}`);
      params.push(updates.workflowId);
    }
    if (updates.status !== undefined) {
      setParts.push(`status = $${paramIndex++}`);
      params.push(updates.status);
    }
    if (updates.stepId !== undefined) {
      setParts.push(`step_id = $${paramIndex++}`);
      params.push(updates.stepId);
    }
    if (updates.state !== undefined) {
      setParts.push(`state = $${paramIndex++}`);
      params.push(JSON.stringify(updates.state));
    }
    if (updates.suspendedAt !== undefined) {
      setParts.push(`suspended_at = $${paramIndex++}`);
      params.push(updates.suspendedAt);
    }
    if (updates.resumeData !== undefined) {
      setParts.push(`resume_data = $${paramIndex++}`);
      params.push(updates.resumeData ? JSON.stringify(updates.resumeData) : null);
    }

    if (setParts.length === 0) return;

    setParts.push(`updated_at = $${paramIndex++}`);
    params.push(new Date());

    await this.pool.query(
      `UPDATE ${this.table("workflow_states")} SET ${setParts.join(", ")} WHERE execution_id = $1`,
      params,
    );
  }

  async getSuspendedWorkflowStates(workflowId: string): Promise<WorkflowStateEntry[]> {
    const result = await this.pool.query(
      `SELECT * FROM ${this.table("workflow_states")}
       WHERE workflow_id = $1 AND status = 'suspended'
       ORDER BY suspended_at DESC`,
      [workflowId],
    );

    return result.rows.map(mapWorkflowStateRow);
  }

  // ============================================================================
  // Pool Management
  // ============================================================================

  async close(): Promise<void> {
    await this.pool.end();
    this.initialized = false;
  }

  getPool(): Pool {
    return this.pool;
  }

  isInitialized(): boolean {
    return this.initialized;
  }
}

/**
 * Factory function to create PostgresStorageAdapter with DATABASE_URL from environment
 */
export function createPostgresStorageAdapter(
  options?: Partial<PostgresStorageAdapterOptions>,
): PostgresStorageAdapter {
  return new PostgresStorageAdapter({
    connectionString: process.env.DATABASE_URL,
    ...options,
  });
}
