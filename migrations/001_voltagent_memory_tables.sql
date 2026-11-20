-- ============================================================================
-- Migration 001: VoltAgent Memory V2 Tables
-- ============================================================================
-- Creates tables for VoltAgent Memory V2 PostgreSQL Storage Adapter
-- Run this on the crm_ai database (shared with nodus-teste CRM)
-- ============================================================================

-- Set table prefix (change if needed)
-- Tables will be: voltagent_conversations, voltagent_messages, etc.

-- 1. Conversations Table
-- ============================================================================
CREATE TABLE IF NOT EXISTS voltagent_conversations (
    id VARCHAR(255) PRIMARY KEY,
    resource_id VARCHAR(255),
    title VARCHAR(500),
    user_id VARCHAR(255) NOT NULL,
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_voltagent_conversations_user_id
    ON voltagent_conversations(user_id);
CREATE INDEX IF NOT EXISTS idx_voltagent_conversations_resource_id
    ON voltagent_conversations(resource_id);
CREATE INDEX IF NOT EXISTS idx_voltagent_conversations_updated_at
    ON voltagent_conversations(updated_at DESC);

-- 2. Messages Table
-- ============================================================================
CREATE TABLE IF NOT EXISTS voltagent_messages (
    id VARCHAR(255) PRIMARY KEY,
    conversation_id VARCHAR(255) NOT NULL REFERENCES voltagent_conversations(id) ON DELETE CASCADE,
    user_id VARCHAR(255) NOT NULL,
    role VARCHAR(50) NOT NULL,
    parts JSONB,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_voltagent_messages_conversation_user
    ON voltagent_messages(conversation_id, user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_voltagent_messages_user_id
    ON voltagent_messages(user_id);

-- 3. Working Memory Table
-- ============================================================================
CREATE TABLE IF NOT EXISTS voltagent_working_memory (
    scope VARCHAR(50) NOT NULL,
    user_id VARCHAR(255),
    conversation_id VARCHAR(255),
    content TEXT NOT NULL,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    PRIMARY KEY (scope, user_id, conversation_id)
);

CREATE INDEX IF NOT EXISTS idx_voltagent_working_memory_user_conversation
    ON voltagent_working_memory(user_id, conversation_id);

-- 4. Workflow States Table
-- ============================================================================
-- state JSONB stores the full WorkflowStateEntry object (serialized)
-- execution_id = WorkflowStateEntry.id
-- workflow_id and status are indexed separately for fast queries
CREATE TABLE IF NOT EXISTS voltagent_workflow_states (
    execution_id VARCHAR(255) PRIMARY KEY,
    workflow_id VARCHAR(255) NOT NULL,
    status VARCHAR(50) NOT NULL,
    state JSONB NOT NULL DEFAULT '{}',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_voltagent_workflow_states_workflow_id
    ON voltagent_workflow_states(workflow_id);
CREATE INDEX IF NOT EXISTS idx_voltagent_workflow_states_status
    ON voltagent_workflow_states(status);
CREATE INDEX IF NOT EXISTS idx_voltagent_workflow_states_user
    ON voltagent_workflow_states((state->>'userId')) WHERE state ? 'userId';

-- 5. Conversation Steps Table
-- ============================================================================
-- step_index = ConversationStepRecord.stepIndex
-- step_type  = ConversationStepRecord.type (ConversationStepType enum)
-- arguments, result, usage stored as JSONB
CREATE TABLE IF NOT EXISTS voltagent_conversation_steps (
    id VARCHAR(255) PRIMARY KEY,
    conversation_id VARCHAR(255) NOT NULL REFERENCES voltagent_conversations(id) ON DELETE CASCADE,
    user_id VARCHAR(255) NOT NULL,
    agent_id VARCHAR(255) NOT NULL,
    agent_name VARCHAR(255),
    operation_id VARCHAR(255) NOT NULL,
    step_index INTEGER NOT NULL,
    step_type VARCHAR(50) NOT NULL,
    role VARCHAR(50) NOT NULL,
    content TEXT,
    arguments JSONB,
    result JSONB,
    usage JSONB,
    sub_agent_id VARCHAR(255),
    sub_agent_name VARCHAR(255),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_voltagent_conversation_steps_conversation
    ON voltagent_conversation_steps(conversation_id, user_id, step_index);
CREATE INDEX IF NOT EXISTS idx_voltagent_conversation_steps_operation
    ON voltagent_conversation_steps(operation_id);

-- 6. Users Table (for metadata)
-- ============================================================================
CREATE TABLE IF NOT EXISTS voltagent_users (
    id VARCHAR(255) PRIMARY KEY,
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 7. Function to get conversation with messages
-- ============================================================================
CREATE OR REPLACE FUNCTION voltagent_get_conversation_with_messages(
    p_conversation_id VARCHAR(255),
    p_user_id VARCHAR(255),
    p_limit INTEGER DEFAULT 100,
    p_offset INTEGER DEFAULT 0
) RETURNS TABLE (
    conversation_id VARCHAR(255),
    conversation_title VARCHAR(500),
    message_id VARCHAR(255),
    message_role VARCHAR(50),
    message_parts JSONB,
    message_created_at TIMESTAMP WITH TIME ZONE
) AS $$
BEGIN
    RETURN QUERY
    SELECT
        c.id,
        c.title,
        m.id,
        m.role,
        m.parts,
        m.created_at
    FROM voltagent_conversations c
    LEFT JOIN voltagent_messages m
        ON c.id = m.conversation_id
        AND m.user_id = p_user_id
    WHERE c.id = p_conversation_id
        AND c.user_id = p_user_id
    ORDER BY m.created_at ASC
    LIMIT p_limit OFFSET p_offset;
END;
$$ LANGUAGE plpgsql;

-- 8. Function to get working memory for a scope
-- ============================================================================
CREATE OR REPLACE FUNCTION voltagent_get_working_memory(
    p_scope VARCHAR(50),
    p_user_id VARCHAR(255),
    p_conversation_id VARCHAR(255) DEFAULT NULL
) RETURNS TABLE (content TEXT) AS $$
BEGIN
    RETURN QUERY
    SELECT content FROM voltagent_working_memory
    WHERE scope = p_scope
        AND user_id = p_user_id
        AND conversation_id = p_conversation_id;
END;
$$ LANGUAGE plpgsql;

-- 9. Function to cleanup old workflow states
-- ============================================================================
CREATE OR REPLACE FUNCTION voltagent_cleanup_old_workflow_states(
    p_days INTEGER DEFAULT 30
) RETURNS INTEGER AS $$
DECLARE
    v_deleted INTEGER;
BEGIN
    DELETE FROM voltagent_workflow_states
    WHERE status IN ('completed', 'error', 'cancelled')
        AND updated_at < NOW() - (p_days || ' days')::INTERVAL;
    GET DIAGNOSTICS v_deleted = ROW_COUNT;
    RETURN v_deleted;
END;
$$ LANGUAGE plpgsql;

-- 10. Function to cleanup old conversations
-- ============================================================================
CREATE OR REPLACE FUNCTION voltagent_cleanup_old_conversations(
    p_days INTEGER DEFAULT 90
) RETURNS INTEGER AS $$
DECLARE
    v_deleted INTEGER;
BEGIN
    DELETE FROM voltagent_conversations
    WHERE updated_at < NOW() - (p_days || ' days')::INTERVAL;
    GET DIAGNOSTICS v_deleted = ROW_COUNT;
    RETURN v_deleted;
END;
$$ LANGUAGE plpgsql;

-- ============================================================================
-- GRANT PERMISSIONS (adjust for your application user)
-- ============================================================================
-- GRANT SELECT, INSERT, UPDATE, DELETE ON voltagent_conversations TO seu_usuario_app;
-- GRANT SELECT, INSERT, UPDATE, DELETE ON voltagent_messages TO seu_usuario_app;
-- GRANT SELECT, INSERT, UPDATE, DELETE ON voltagent_working_memory TO seu_usuario_app;
-- GRANT SELECT, INSERT, UPDATE, DELETE ON voltagent_workflow_states TO seu_usuario_app;
-- GRANT SELECT, INSERT, UPDATE, DELETE ON voltagent_conversation_steps TO seu_usuario_app;
-- GRANT SELECT, INSERT, UPDATE, DELETE ON voltagent_users TO seu_usuario_app;
-- GRANT EXECUTE ON FUNCTION voltagent_get_conversation_with_messages TO seu_usuario_app;
-- GRANT EXECUTE ON FUNCTION voltagent_get_working_memory TO seu_usuario_app;
-- GRANT EXECUTE ON FUNCTION voltagent_cleanup_old_workflow_states TO seu_usuario_app;
-- GRANT EXECUTE ON FUNCTION voltagent_cleanup_old_conversations TO seu_usuario_app;

-- ============================================================================
-- END OF MIGRATION
-- ============================================================================
