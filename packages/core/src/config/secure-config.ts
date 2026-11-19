/**
 * Secure Configuration Adapter for VoltAgent
 *
 * Reads secrets from /home/opc/cofre-local/ instead of process.env
 * This prevents secrets from being exposed in process listings, logs, or git.
 *
 * Usage:
 *   import { loadSecret, loadAllSecrets } from "@voltagent/core/config/secure-config";
 *
 *   const apiKey = loadSecret("openrouter-api-key");
 *   const dbUrl = loadSecret("database-url");
 *
 * Or use the VoltAgentConfig class for a complete configuration object.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const COFRE_LOCAL_PATH = "/home/opc/cofre-local";

/**
 * Carrega um segredo do cofre-local
 * @param name - Nome do arquivo no cofre-local (ex: "openrouter-api-key")
 * @returns O conteúdo do arquivo sem whitespace
 * @throws Error se arquivo não existir
 */
export function loadSecret(name: string): string {
  const filePath = join(COFRE_LOCAL_PATH, name);

  if (!existsSync(filePath)) {
    throw new Error(`Secret not found in cofre-local: ${name}`);
  }

  return readFileSync(filePath, "utf-8").trim();
}

/**
 * Tenta carregar um segredo, retorna undefined se não existir
 * @param name - Nome do arquivo no cofre-local
 * @returns O conteúdo do arquivo ou undefined
 */
export function tryLoadSecret(name: string): string | undefined {
  try {
    return loadSecret(name);
  } catch {
    return undefined;
  }
}

/**
 * Carrega múltiplos segredos de uma vez
 * @param names - Array de nomes de arquivos no cofre-local
 * @returns Objeto com os segredos carregados
 */
export function loadSecrets(names: string[]): Record<string, string> {
  const result: Record<string, string> = {};

  for (const name of names) {
    try {
      result[name] = loadSecret(name);
    } catch (_error) {
      // Log mas não falha - alguns segredos podem ser opcionais
      console.warn(`[SecureConfig] Secret not found: ${name}`);
    }
  }

  return result;
}

/**
 * Carrega todos os segredos do cofre-local
 * @returns Objeto com todos os segredos
 */
export function loadAllSecrets(): Record<string, string> {
  const { readdirSync } = require("node:fs");

  try {
    const files = readdirSync(COFRE_LOCAL_PATH);
    const result: Record<string, string> = {};

    for (const file of files) {
      // Ignora arquivos ocultos e backups
      if (file.startsWith(".") || file.endsWith(".bak") || file.endsWith(".backup")) {
        continue;
      }

      try {
        result[file] = loadSecret(file);
      } catch {
        // Ignora arquivos que não podem ser lidos
      }
    }

    return result;
  } catch {
    return {};
  }
}

/**
 * Mapeia nomes de segredos do cofre-local para variáveis de ambiente esperadas
 * Útil para compatibilidade com código que usa process.env
 */
export const SECRET_TO_ENV_MAP: Record<string, string> = {
  "openrouter-api-key": "OPENROUTER_API_KEY",
  "gemini-api-key": "GOOGLE_API_KEY",
  "nvidia-nim-key": "NVIDIA_NIM_KEY",
  "evolution-apikey-20261025-1616.txt": "EVOLUTION_API_KEY",
  "hermes-webhook-shared-secret": "HERMES_WEBHOOK_SECRET",
  "crm-internal-api-token": "INTERNAL_API_TOKEN",
  "crm-mcp-token": "CRM_MCP_TOKEN",
  "smtp-comercial-3lg": "SMTP_PASSWORD",
  "grafana-hermes-password": "GRAFANA_PASSWORD",
};

/**
 * Aplica segredos do cofre-local ao process.env (para compatibilidade)
 * ATENÇÃO: Use apenas quando necessário - preferência é usar loadSecret() diretamente
 */
export function applySecretsToEnv(secrets?: Record<string, string>): void {
  const toApply = secrets || loadAllSecrets();

  for (const [fileName, value] of Object.entries(toApply)) {
    const envVar = SECRET_TO_ENV_MAP[fileName];
    if (envVar && !process.env[envVar]) {
      process.env[envVar] = value;
    }
  }
}

/**
 * Classe de configuração do VoltAgent que usa cofre-local
 * Substitui o uso direto de process.env
 */
export class VoltAgentSecureConfig {
  private secrets: Record<string, string>;

  constructor(secrets?: Record<string, string>) {
    this.secrets = secrets || loadAllSecrets();
    // Aplica ao process.env para compatibilidade com bibliotecas que leem de lá
    applySecretsToEnv(this.secrets);
  }

  get(key: string): string | undefined {
    // Primeiro tenta mapear via SECRET_TO_ENV_MAP
    const mappedKey = SECRET_TO_ENV_MAP[key];
    if (mappedKey && this.secrets[mappedKey]) {
      return this.secrets[mappedKey];
    }

    // Tenta chave direta
    if (this.secrets[key]) {
      return this.secrets[key];
    }

    // Fallback para process.env (já populado pelo applySecretsToEnv)
    return process.env[key];
  }

  getRequired(key: string): string {
    const value = this.get(key);
    if (!value) {
      throw new Error(`Required secret not found: ${key}`);
    }
    return value;
  }

  getNumber(key: string, defaultValue: number): number {
    const value = this.get(key);
    return value ? Number.parseFloat(value) : defaultValue;
  }

  getBoolean(key: string, defaultValue: boolean): boolean {
    const value = this.get(key);
    if (!value) return defaultValue;
    return value.toLowerCase() === "true" || value === "1";
  }

  // Helpers para configurações comuns
  get openRouterApiKey(): string {
    return this.getRequired("OPENROUTER_API_KEY");
  }
  get googleApiKey(): string {
    return this.getRequired("GOOGLE_API_KEY");
  }
  get nvidiaNimKey(): string {
    return this.getRequired("NVIDIA_NIM_KEY");
  }
  get evolutionApiKey(): string {
    return this.getRequired("EVOLUTION_API_KEY");
  }
  get hermesWebhookSecret(): string {
    return this.getRequired("HERMES_WEBHOOK_SECRET");
  }
  get internalApiToken(): string {
    return this.getRequired("INTERNAL_API_TOKEN");
  }
  get crmMcpToken(): string {
    return this.getRequired("CRM_MCP_TOKEN");
  }
  get smtpPassword(): string {
    return this.getRequired("SMTP_PASSWORD");
  }
  get grafanaPassword(): string {
    return this.getRequired("GRAFANA_PASSWORD");
  }
}

// Export singleton instance
export const secureConfig = new VoltAgentSecureConfig();
