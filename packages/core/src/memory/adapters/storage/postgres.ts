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
 *
 * Requires migration 001_voltagent_memory_tables.sql to create these tables.
 */

import { randomUUID } from "node:crypto";
import { safeStringify } from "@voltagent/internal/utils";
import type { UIMessage } from "ai";
import { Pool, type PoolConfig } from "pg";
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
  WorkflowRunQuery,
  WorkflowStateEntry,
  WorkingMemoryScope,
} from "../../types";

function mapConversationRow(row: any): Conversation {
  return {
    id: row.id,
    resourceId: row.resource_id ?? "",
    title: row.title ?? "",
    userId: row.user_id,
    metadata: row.metadata ?? {},
    createdAt: (row.created_at instanceof Date
      ? row.created_at
      : new Date(row.created_at)
    ).toISOString(),
    updatedAt: (row.updated_at instanceof Date
      ? row.updated_at
      : new Date(row.updated_at)
    ).toISOString(),
  };
}

function mapWorkflowStateRow(row: any): WorkflowStateEntry {
  const data = typeof row.state === "string" ? JSON.parse(row.state) : (row.state ?? {});
  return {
    ...data,
    id: row.execution_id,
    workflowId: row.workflow_id,
    status: row.status,
    createdAt: row.created_at instanceof Date ? row.created_at : new Date(row.created_at),
    updatedAt: row.updated_at instanceof Date ? row.updated_at : new Date(row.updated_at),
  };
}

function mapConversationStepRow(row: any): ConversationStepRecord {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    userId: row.user_id,
    agentId: row.agent_id,
    agentName: row.agent_name ?? undefined,
    operationId: row.operation_id,
    stepIndex: row.step_index,
    type: row.step_type,
    role: row.role,
    content: row.content ?? undefined,
    arguments: row.arguments ?? undefined,
    result: row.result ?? undefined,
    usage: row.usage
      ? typeof row.usage === "string"
        ? JSON.parse(row.usage)
        : row.usage
      : undefined,
    subAgentId: row.sub_agent_id ?? undefined,
    subAgentName: row.sub_agent_name ?? undefined,
    createdAt: (row.created_at instanceof Date
      ? row.created_at
      : new Date(row.created_at)
    ).toISOString(),
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

  async initialize(): Promise<void> {
    if (this.initialized) return;
    const client = await this.pool.connect();
    try {
      await client.query("SELECT 1");
    } finally {
      client.release();
    }
    this.initialized = true;
  }

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
        await client.query(
          `INSERT INTO ${this.table("messages")}
            (id, conversation_id, user_id, role, parts, created_at)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (id) DO UPDATE SET parts = EXCLUDED.parts`,
          [
            id,
            conversationId,
            userId,
            message.role,
            safeStringify(message.parts ?? []),
            new Date(),
          ],
        );
      }

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
    const conditions = ["user_id = $1", "conversation_id = $2"];
    const params: unknown[] = [userId, conversationId];
    let paramIndex = 3;

    if (options?.roles && options.roles.length > 0) {
      const rolePlaceholders = options.roles.map(() => `$${paramIndex++}`).join(", ");
      conditions.push(`role IN (${rolePlaceholders})`);
      params.push(...options.roles);
    }
    if (options?.before) {
      conditions.push(`created_at < $${paramIndex++}`);
      params.push(options.before);
    }
    if (options?.after) {
      conditions.push(`created_at > $${paramIndex++}`);
      params.push(options.after);
    }

    const limit = options?.limit ?? 100;
    params.push(limit);

    const result = await this.pool.query(
      `SELECT id, role, parts, created_at
       FROM ${this.table("messages")}
       WHERE ${conditions.join(" AND ")}
       ORDER BY created_at ASC
       LIMIT $${paramIndex}`,
      params,
    );

    return result.rows.map((row) => {
      const parts = row.parts
        ? typeof row.parts === "string"
          ? JSON.parse(row.parts)
          : row.parts
        : [];
      const msg = {
        id: row.id,
        role: row.role,
        parts,
        metadata: {
          createdAt: row.created_at instanceof Date ? row.created_at : new Date(row.created_at),
        },
      };
      return msg as unknown as UIMessage<{ createdAt: Date }>;
    });
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
    const now = new Date();
    try {
      const result = await this.pool.query(
        `INSERT INTO ${this.table("conversations")}
          (id, resource_id, title, user_id, metadata, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING *`,
        [
          input.id,
          input.resourceId,
          input.title,
          input.userId,
          safeStringify(input.metadata ?? {}),
          now,
          now,
        ],
      );
      return mapConversationRow(result.rows[0]);
    } catch (error: any) {
      if (error.code === "23505") throw new ConversationAlreadyExistsError(input.id);
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
      `SELECT * FROM ${this.table("conversations")} WHERE resource_id = $1 ORDER BY updated_at DESC`,
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
    const orderBy = options?.orderBy ?? "updated_at";
    const orderDir = options?.orderDirection ?? "DESC";

    const result = await this.pool.query(
      `SELECT * FROM ${this.table("conversations")}
       WHERE user_id = $1
       ORDER BY ${orderBy} ${orderDir}
       LIMIT $2 OFFSET $3`,
      [userId, limit, offset],
    );
    return result.rows.map(mapConversationRow);
  }

  async queryConversations(options: ConversationQueryOptions): Promise<Conversation[]> {
    const conditions: string[] = [];
    const params: unknown[] = [];
    let paramIndex = 1;

    if (options.userId) {
      conditions.push(`user_id = $${paramIndex++}`);
      params.push(options.userId);
    }
    if (options.resourceId) {
      conditions.push(`resource_id = $${paramIndex++}`);
      params.push(options.resourceId);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const limit = options.limit ?? 50;
    const offset = options.offset ?? 0;
    const orderBy = options.orderBy ?? "updated_at";
    const orderDir = options.orderDirection ?? "DESC";

    params.push(limit, offset);

    const result = await this.pool.query(
      `SELECT * FROM ${this.table("conversations")}
       ${whereClause}
       ORDER BY ${orderBy} ${orderDir}
       LIMIT $${paramIndex++} OFFSET $${paramIndex}`,
      params,
    );
    return result.rows.map(mapConversationRow);
  }

  async countConversations(options: ConversationQueryOptions): Promise<number> {
    const conditions: string[] = [];
    const params: unknown[] = [];
    let paramIndex = 1;

    if (options.userId) {
      conditions.push(`user_id = $${paramIndex++}`);
      params.push(options.userId);
    }
    if (options.resourceId) {
      conditions.push(`resource_id = $${paramIndex++}`);
      params.push(options.resourceId);
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
    const params: unknown[] = [id];
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
      params.push(safeStringify(updates.metadata));
    }

    if (setParts.length === 0) {
      const existing = await this.getConversation(id);
      if (!existing) throw new ConversationNotFoundError(id);
      return existing;
    }

    setParts.push(`updated_at = $${paramIndex++}`);
    params.push(new Date());

    const result = await this.pool.query(
      `UPDATE ${this.table("conversations")}
       SET ${setParts.join(", ")}
       WHERE id = $1 RETURNING *`,
      params,
    );
    if (result.rows.length === 0) throw new ConversationNotFoundError(id);
    return mapConversationRow(result.rows[0]);
  }

  async deleteConversation(id: string): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`DELETE FROM ${this.table("messages")} WHERE conversation_id = $1`, [id]);
      await client.query(`DELETE FROM ${this.table("conversations")} WHERE id = $1`, [id]);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  // ============================================================================
  // Conversation Steps
  // ============================================================================

  async saveConversationSteps(steps: ConversationStepRecord[]): Promise<void> {
    if (steps.length === 0) return;
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      for (const step of steps) {
        await client.query(
          `INSERT INTO ${this.table("conversation_steps")}
            (id, conversation_id, user_id, agent_id, agent_name, operation_id,
             step_index, step_type, role, content, arguments, result, usage,
             sub_agent_id, sub_agent_name, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
           ON CONFLICT (id) DO UPDATE SET
             result = EXCLUDED.result,
             usage = EXCLUDED.usage`,
          [
            step.id,
            step.conversationId,
            step.userId,
            step.agentId,
            step.agentName ?? null,
            step.operationId,
            step.stepIndex,
            step.type,
            step.role,
            step.content ?? null,
            step.arguments ? safeStringify(step.arguments) : null,
            step.result ? safeStringify(step.result) : null,
            step.usage ? safeStringify(step.usage) : null,
            step.subAgentId ?? null,
            step.subAgentName ?? null,
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
    const conditions = ["user_id = $1", "conversation_id = $2"];
    const params: unknown[] = [userId, conversationId];
    let paramIndex = 3;

    if (options?.operationId) {
      conditions.push(`operation_id = $${paramIndex++}`);
      params.push(options.operationId);
    }

    const limitClause = options?.limit ? `LIMIT $${paramIndex}` : "";
    if (options?.limit) params.push(options.limit);

    const result = await this.pool.query(
      `SELECT * FROM ${this.table("conversation_steps")}
       WHERE ${conditions.join(" AND ")}
       ORDER BY step_index ASC
       ${limitClause}`,
      params,
    );
    return result.rows.map(mapConversationStepRow);
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
    const params: unknown[] = [];
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
        (execution_id, workflow_id, status, state, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (execution_id) DO UPDATE SET
         workflow_id = EXCLUDED.workflow_id,
         status = EXCLUDED.status,
         state = EXCLUDED.state,
         updated_at = EXCLUDED.updated_at`,
      [
        executionId,
        state.workflowId,
        state.status,
        safeStringify(state),
        state.createdAt,
        state.updatedAt,
      ],
    );
  }

  async updateWorkflowState(
    executionId: string,
    updates: Partial<WorkflowStateEntry>,
  ): Promise<void> {
    const current = await this.getWorkflowState(executionId);
    if (!current) return;
    const updated: WorkflowStateEntry = { ...current, ...updates, updatedAt: new Date() };
    await this.setWorkflowState(executionId, updated);
  }

  async getSuspendedWorkflowStates(workflowId: string): Promise<WorkflowStateEntry[]> {
    const result = await this.pool.query(
      `SELECT * FROM ${this.table("workflow_states")}
       WHERE workflow_id = $1 AND status = 'suspended'
       ORDER BY updated_at DESC`,
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
