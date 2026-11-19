/**
 * Hermes Integration Agent Example
 *
 * Demonstrates how to create a VoltAgent agent that:
 * 1. Uses secure config from cofre-local
 * 2. Uses PostgresStorageAdapter for shared memory with Python Hermes
 * 3. Uses CircuitBreaker for resilient external calls
 * 4. Integrates with nodus-teste CRM data
 *
 * Run with: npx tsx examples/hermes-integration-agent.ts
 */

import {
  Agent,
  // Resilience
  CircuitBreakerRegistry,
  // Memory
  Memory,
  PostgresStorageAdapter,
  // Types
  type Tool,
  VoltAgent,
  createHttpCircuitBreaker,
  createPostgresStorageAdapter,
  // Tools
  createTool,
  loadSecret,
  // Config
  secureConfig,
} from "@voltagent/core";

import { z } from "zod";

// ============================================================================
// 1. Secure Configuration from cofre-local
// ============================================================================

// Load secrets securely (never hardcode!)
// const openRouterKey = loadSecret("openrouter-api-key"); // throws if not found
// const openRouterKey = secureConfig.get("OPENROUTER_API_KEY"); // with fallback to process.env

// For this example, we'll use the secureConfig singleton
const config = secureConfig;

// ============================================================================
// 2. PostgreSQL Storage Adapter (shared with nodus-teste)
// ============================================================================

// Create storage adapter pointing to the same crm_ai database
const storageAdapter = createPostgresStorageAdapter({
  tablePrefix: "voltagent_",
  // connectionString is read from DATABASE_URL env var (loaded by secureConfig)
});

// Initialize the adapter (creates pool, tests connection)
await storageAdapter.initialize();

// Create Memory instance with PostgreSQL backend
const sharedMemory = new Memory({
  storage: storageAdapter,
  // Optionally add vector/embedding adapters for semantic search
});

// ============================================================================
// 3. Circuit Breakers for External Services
// ============================================================================

// Circuit breaker for BWT API calls
const _bwtCircuitBreaker = createHttpCircuitBreaker("bwt-api");

// Circuit breaker for Orinter API calls
const _orinterCircuitBreaker = createHttpCircuitBreaker("orinter-api");

// Circuit breaker for Multidestinos API calls
const _multidestinosCircuitBreaker = createHttpCircuitBreaker("multidestinos-api");

// Circuit breaker for CRM internal API
const crmCircuitBreaker = createHttpCircuitBreaker("crm-internal");

// Register all breakers for monitoring
const breakerRegistry = CircuitBreakerRegistry.getInstance();

// ============================================================================
// 4. Tools that use Circuit Breakers and CRM Data
// ============================================================================

/**
 * Tool to search travel packages via CRM internal API
 * Uses circuit breaker for resilience
 */
const searchPackagesTool = createTool({
  name: "search_travel_packages",
  description: "Busca pacotes de viagem no CRM 3LG (BWT, Orinter, Multidestinos)",
  parameters: z.object({
    origem: z.string().describe("Código IATA de origem (ex: GRU)"),
    destino: z.string().describe("Código IATA de destino (ex: GIG)"),
    dataIda: z.string().describe("Data de ida (YYYY-MM-DD)"),
    dataVolta: z.string().describe("Data de volta (YYYY-MM-DD)"),
    adultos: z.number().int().min(1).max(9).default(2),
    criancas: z.number().int().min(0).max(9).default(0),
  }),
  execute: async ({ origem, destino, dataIda, dataVolta, adultos, criancas }) => {
    return await crmCircuitBreaker.execute(async () => {
      const response = await fetch("http://localhost:8000/v2/hermes/controlador", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${config.getRequired("HERMES_API_TOKEN")}`,
        },
        body: JSON.stringify({
          telefone: "5511999999999", // system user
          mensagem_cliente: `Quero pacote de ${origem} para ${destino} de ${dataIda} a ${dataVolta} para ${adultos} adultos${criancas > 0 ? ` e ${criancas} crianças` : ""}`,
          memoria: {
            etapa: "identificando_necessidade",
            interesse: `${origem} -> ${destino}`,
            periodo: `${dataIda} a ${dataVolta}`,
            passageiros: `${adultos} adultos${criancas > 0 ? `, ${criancas} crianças` : ""}`,
            origem: origem,
            ultima_pergunta: null,
          },
          contexto_tecnico: {
            etapa_atual: "identificando_necessidade",
            cotacao_em_andamento: false,
            msgs_robo_sem_retorno: 0,
            humano_ativo: false,
          },
        }),
      });

      if (!response.ok) {
        throw new Error(`CRM API error: ${response.status}`);
      }

      return await response.json();
    });
  },
});

/**
 * Tool to get conversation history from shared memory
 */
const getConversationHistoryTool = createTool({
  name: "get_conversation_history",
  description: "Recupera histórico de conversa do cliente na memória compartilhada",
  parameters: z.object({
    telefone: z.string().describe("Telefone do cliente (ex: 5511999999999)"),
    limite: z.number().int().min(1).max(100).default(20),
  }),
  execute: async ({ telefone, limite }) => {
    // Use the shared memory to get conversation
    const conversation = await storageAdapter.getConversation(telefone);
    if (!conversation) {
      return { messages: [], found: false };
    }

    const messages = await storageAdapter.getMessages(telefone, telefone, {
      limit: limite,
      order: "desc",
    });

    return {
      found: true,
      conversationId: conversation.id,
      messageCount: messages.length,
      messages: messages.reverse(), // chronological order
    };
  },
});

/**
 * Tool to save interaction to shared memory
 */
const saveInteractionTool = createTool({
  name: "save_interaction",
  description: "Salva interação na memória compartilhada (acessível pelo Python Hermes)",
  parameters: z.object({
    telefone: z.string().describe("Telefone do cliente"),
    role: z.enum(["user", "assistant", "system"]).describe("Papel da mensagem"),
    content: z.string().describe("Conteúdo da mensagem"),
  }),
  execute: async ({ telefone, role, content }) => {
    // Ensure conversation exists
    let conversation = await storageAdapter.getConversation(telefone);
    if (!conversation) {
      conversation = await storageAdapter.createConversation({
        id: telefone,
        userId: telefone,
        resourceId: telefone,
        title: `Conversa com ${telefone}`,
      });
    }

    // Add message to shared memory
    await storageAdapter.addMessage(
      {
        id: crypto.randomUUID(),
        role: role as any,
        content,
      },
      telefone,
      telefone,
    );

    return { success: true, conversationId: conversation.id };
  },
});

/**
 * Tool to check circuit breaker status
 */
const checkCircuitBreakersTool = createTool({
  name: "check_circuit_breakers",
  description: "Verifica status dos circuit breakers dos serviços externos",
  parameters: z.object({}),
  execute: async () => {
    return breakerRegistry.getAllStats();
  },
});

/**
 * Tool to reset a circuit breaker (admin)
 */
const resetCircuitBreakerTool = createTool({
  name: "reset_circuit_breaker",
  description: "Reseta um circuit breaker específico (uso administrativo)",
  parameters: z.object({
    name: z.string().describe("Nome do circuit breaker (ex: http-bwt-api)"),
  }),
  execute: async ({ name }) => {
    const breaker = breakerRegistry.get(name);
    if (!breaker) {
      return { success: false, error: `Circuit breaker not found: ${name}` };
    }
    breaker.reset();
    return { success: true, name, state: breaker.stats.state };
  },
});

// ============================================================================
// 5. Create the Hermes Integration Agent
// ============================================================================

const hermesIntegrationAgent = new Agent({
  name: "hermes-integration-agent",
  description: "Agent que integra VoltAgent com Hermes Python via memória PostgreSQL compartilhada",

  // Use the shared memory for conversation persistence
  memory: sharedMemory,

  // Instructions for the agent
  instructions: `
    Você é um agente de integração entre VoltAgent (TypeScript) e Hermes Controlador (Python).

    Sua missão é demonstrar como os dois ecossistemas podem trabalhar juntos:

    1. MEMÓRIA COMPARTILHADA: Use o PostgresStorageAdapter para ler/escrever conversas
       que o Python Hermes também acessa (tabela voltagent_conversations, voltagent_messages).

    2. CIRCUIT BREAKERS: Todas as chamadas externas (BWT, Orinter, Multidestinos, CRM)
       passam por circuit breakers para resiliência.

    3. CONFIGURAÇÃO SEGURA: Secrets vêm do /home/opc/cofre-local/ via secureConfig.

    FERRAMENTAS DISPONÍVEIS:
    - search_travel_packages: Busca pacotes via CRM API (com circuit breaker)
    - get_conversation_history: Lê histórico da memória compartilhada
    - save_interaction: Salva interação na memória compartilhada
    - check_circuit_breakers: Monitora saúde dos circuit breakers
    - reset_circuit_breaker: Reset administrativo de circuit breaker

    REGRAS:
    - Sempre use save_interaction para persistir mensagens importantes
    - Verifique circuit breakers antes de chamar APIs externas críticas
    - Use a memória compartilhada para manter contexto entre Python e TypeScript
  `,

  // Tools available to the agent
  tools: [
    searchPackagesTool,
    getConversationHistoryTool,
    saveInteractionTool,
    checkCircuitBreakersTool,
    resetCircuitBreakerTool,
  ],

  // Model configuration (uses secure config)
  // model: config.get("OPENROUTER_MODEL") || "anthropic/claude-3.5-sonnet",
});

// ============================================================================
// 6. Create VoltAgent Instance with the Agent
// ============================================================================

const voltAgent = new VoltAgent({
  agents: {
    "hermes-integration": hermesIntegrationAgent,
  },
  // Global memory for all agents
  memory: sharedMemory,
});

// ============================================================================
// 7. Example Usage
// ============================================================================

async function main() {
  // Wait for VoltAgent to be ready
  await voltAgent.ready;

  // Get the agent
  const agent = voltAgent.getAgent("hermes-integration");
  if (!agent) {
    throw new Error("Agent not found");
  }

  const telefone = "5511999999999";
  await storageAdapter.addMessage(
    {
      id: crypto.randomUUID(),
      role: "user",
      content: "Olá, quero um pacote para Fernando de Noronha",
    },
    telefone,
    telefone,
  );
  const history = await storageAdapter.getMessages(telefone, telefone, { limit: 10 });
  for (const _msg of history) {
  }
  const breakerStats = breakerRegistry.getAllStats();
  for (const [_name, _stats] of Object.entries(breakerStats)) {
  }

  // Cleanup
  await storageAdapter.close();
  await voltAgent.shutdown();
}

// Run if executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(console.error);
}

export { hermesIntegrationAgent, voltAgent, storageAdapter, breakerRegistry };
