import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import fs from "fs";
import path from "path";
import os from "os";
import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

interface NgrokConfig {
  authtoken: string;
}

interface TunnelInfo {
  id: string;
  url: string;
  proto: string;
  config: Record<string, unknown>;
}

const tunnels: Map<string, TunnelInfo> = new Map();

function configPath(): string {
  return path.join(os.homedir(), ".config", "opencode", "ngrok-config.json");
}

/** Authtoken do arquivo de configuração, se existir. Ausente: o ngrok usa a própria configuração. */
function loadAuthtoken(): string | undefined {
  const file = configPath();
  if (!fs.existsSync(file)) return undefined;
  const config = JSON.parse(fs.readFileSync(file, "utf-8")) as Partial<NgrokConfig>;
  return typeof config.authtoken === "string" && config.authtoken ? config.authtoken : undefined;
}

/**
 * Como executar o `npx` sem shell. No Windows o `npx` é um .cmd, que o Node só
 * executa via shell; por isso o `npx-cli.js` do npm é chamado pelo próprio Node.
 * `NGROK_MCP_RUNNER` (caminho de um script .js) substitui o npx nos testes.
 */
function npxCommand(): { command: string; prefix: string[] } {
  const runner = process.env.NGROK_MCP_RUNNER;
  if (runner) return { command: process.execPath, prefix: [runner] };
  if (process.platform !== "win32") return { command: "npx", prefix: [] };
  const cli = path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npx-cli.js");
  return { command: process.execPath, prefix: [cli] };
}

/**
 * Executa `npx ngrok <args>` SEM shell: cada argumento é passado como está,
 * então valores vindos do modelo (auth, descrição, metadados, IDs) não podem
 * injetar comandos. O authtoken vai por variável de ambiente, não por argumento,
 * para não aparecer na lista de processos.
 */
async function runNgrok(args: string[]): Promise<string> {
  const { command, prefix } = npxCommand();
  const authtoken = loadAuthtoken();
  try {
    const { stdout, stderr } = await execFileAsync(command, [...prefix, "ngrok", ...args], {
      encoding: "utf-8",
      maxBuffer: 10 * 1024 * 1024,
      windowsHide: true,
      env: authtoken ? { ...process.env, NGROK_AUTHTOKEN: authtoken } : process.env,
    });
    return stdout || stderr;
  } catch (error: unknown) {
    const err = error as { message?: string; stdout?: string; stderr?: string };
    return err.stdout || err.stderr || err.message || "Unknown error";
  }
}

/** Argumento posicional vindo do modelo não pode começar com "-" (seria lido como flag do ngrok). */
function positional(value: string, label: string): string {
  if (value.startsWith("-")) throw new Error(`${label} inválido: não pode começar com "-"`);
  return value;
}

const server = new McpServer({
  name: "ngrok",
  version: "1.0.0",
});

server.tool(
  "ngrok_list_tunnels",
  "Lista todos os túneis ativos do ngrok",
  {},
  async () => {
    try {
      const output = await runNgrok(["api", "tunnels", "list", "--format=json"]);
      let data;
      try {
        data = JSON.parse(output);
      } catch {
        if (output.includes("no tunnels running") || output.includes("tunnels not found")) {
          return {
            content: [{ type: "text", text: "❌ Nenhum túnel ativo! Execute ngrok_connect ou ngrok_http para criar um." }],
          };
        }
        return {
          content: [{ type: "text", text: `Erro: ${output}` }],
        };
      }
      
      tunnels.clear();
      
      if (!data.tunnels || data.tunnels.length === 0) {
        return {
          content: [{ type: "text", text: "❌ Nenhum túnel ativo! Execute ngrok_connect ou ngrok_http para criar um." }],
        };
      }
      
      for (const tunnel of data.tunnels) {
        tunnels.set(tunnel.id, {
          id: tunnel.id,
          url: tunnel.public_url,
          proto: tunnel.proto,
          config: tunnel.config || {},
        });
      }
      
      let text = `🚇 **Túneis Ativos** (${tunnels.size}):\n\n`;
      for (const [id, tunnel] of tunnels) {
        text += `• ${tunnel.url}\n`;
        text += `  Proto: ${tunnel.proto}\n`;
        text += `  ID: ${id}\n\n`;
      }
      
      return { content: [{ type: "text", text }] };
    } catch (error) {
      return {
        content: [{
          type: "text",
          text: `❌ Erro ao listar túneis: ${error instanceof Error ? error.message : "Erro desconhecido"}`,
        }],
      };
    }
  }
);

server.tool(
  "ngrok_connect",
  "Cria um novo túnel ngrok",
  {
    port: z.number().describe("Porta local para expor"),
    subdomain: z.string().optional().describe("Subdomínio personalizado (requer plano pago)"),
    domain: z.string().optional().describe("Domínio customizado (requer plano pago)"),
    proto: z.enum(["http", "https", "tcp", "tls"]).default("http").describe("Protocolo do túnel"),
    auth: z.string().optional().describe("Auth em formato 'user:pass' para proteger o túnel"),
  },
  async ({ port, subdomain, domain, proto, auth }) => {
    try {
      const args: string[] = [proto, String(port)];
      
      if (subdomain) args.push(`--subdomain=${subdomain}`);
      if (domain) args.push(`--domain=${domain}`);
      if (auth) args.push(`--basic-auth=${auth}`);
      
      const output = await runNgrok(args);
      
      const urlMatch = output.match(/url=([^\s]+)/);
      const idMatch = output.match(/id=([^\s]+)/);
      
      const url = urlMatch ? urlMatch[1] : "Unknown";
      const id = idMatch ? idMatch[1] : "Unknown";
      
      tunnels.set(id, {
        id,
        url,
        proto,
        config: { port, subdomain, domain, auth },
      });
      
      let text = `✅ **Túnel Criado**\n\n`;
      text += `🔗 ${url}\n`;
      text += `📋 Proto: ${proto}\n`;
      text += `🚪 Porta: ${port}\n`;
      text += `🆔 ID: ${id}`;
      
      return { content: [{ type: "text", text }] };
    } catch (error) {
      return {
        content: [{
          type: "text",
          text: `❌ Erro ao criar túnel: ${error instanceof Error ? error.message : "Erro desconhecido"}`,
        }],
      };
    }
  }
);

server.tool(
  "ngrok_disconnect",
  "Desconecta um túnel pelo ID ou URL",
  {
    tunnelId: z.string().optional().describe("ID do túnel"),
    url: z.string().optional().describe("URL do túnel (alternativa ao ID)"),
  },
  async ({ tunnelId, url }) => {
    try {
      let targetId = tunnelId;
      
      if (!targetId && url) {
        for (const [id, tunnel] of tunnels) {
          if (tunnel.url === url) {
            targetId = id;
            break;
          }
        }
      }
      
      if (!targetId) {
        return {
          content: [{ type: "text", text: "❌ Túnel não encontrado. Use ngrok_list_tunnels para ver os túneis ativos." }],
        };
      }
      
      await runNgrok(["disconnect", positional(targetId, "ID do túnel")]);
      tunnels.delete(targetId);
      
      return {
        content: [{
          type: "text",
          text: `✅ **Túnel Desconectado**\n\n🆔 ID: ${targetId}`,
        }],
      };
    } catch (error) {
      return {
        content: [{
          type: "text",
          text: `❌ Erro ao desconectar: ${error instanceof Error ? error.message : "Erro desconhecido"}`,
        }],
      };
    }
  }
);

server.tool(
  "ngrok_status",
  "Mostra o status da sessão ngrok",
  {},
  async () => {
    try {
      const output = await runNgrok(["version"]);
      
      let text = `📊 **Status ngrok**\n\n`;
      text += `Versão: ${output.trim()}\n`;
      text += `\n🟢 ngrok está instalado e configurado.\n`;
      text += `Web Interface: http://127.0.0.1:4040 (quando um túnel estiver ativo)`;
      
      return { content: [{ type: "text", text }] };
    } catch (error) {
      return {
        content: [{
          type: "text",
          text: `❌ Erro ao buscar status: ${error instanceof Error ? error.message : "Erro desconhecido"}`,
        }],
      };
    }
  }
);

server.tool(
  "ngrok_http",
  "Cria um túnel HTTP com opções avançadas",
  {
    port: z.number().describe("Porta local"),
    url: z.string().optional().describe("URL específica do endpoint"),
    subdomain: z.string().optional().describe("Subdomínio (requer plano pago)"),
    domain: z.string().optional().describe("Domínio customizado (requer plano pago)"),
    basicAuth: z.string().optional().describe("Auth básico (user:pass)"),
    hostHeader: z.string().optional().describe("Host header para roteamento"),
    requestHeaderAdd: z.string().optional().describe("Adicionar header na requisição (formato: 'Header:Value')"),
    responseHeaderAdd: z.string().optional().describe("Adicionar header na resposta (formato: 'Header:Value')"),
    compression: z.boolean().optional().describe("Habilitar compressão gzip"),
    cidrAllow: z.string().optional().describe("Permitir CIDRs específicos (ex: 192.168.1.0/24)"),
    cidrDeny: z.string().optional().describe("Bloquear CIDRs específicos"),
    oauthProvider: z.string().optional().describe("Provedor OAuth (google, github, microsoft, slack)"),
    oauthAllowDomain: z.string().optional().describe("Domínios permitidos no OAuth"),
    oauthAllowEmail: z.string().optional().describe("Emails permitidos no OAuth"),
    oauthScope: z.string().optional().describe("Scopes OAuth (comma-separated)"),
    webhookVerification: z.string().optional().describe("Verificação de webhook (slack, discord, etc)"),
    webhookSecret: z.string().optional().describe("Secret do webhook para verificação"),
    mutualTlsCas: z.string().optional().describe("Path para CA cert para mTLS"),
    metadata: z.string().optional().describe("Metadados customizados (JSON)"),
    description: z.string().optional().describe("Descrição do endpoint"),
    name: z.string().optional().describe("Nome do endpoint"),
    inspect: z.boolean().optional().describe("Habilitar inspeção HTTP (default: true)"),
    trafficPolicyFile: z.string().optional().describe("Path para arquivo de traffic policy (YAML/JSON)"),
  },
  async ({ 
    port, url, subdomain, domain, basicAuth, hostHeader,
    requestHeaderAdd, responseHeaderAdd, compression,
    cidrAllow, cidrDeny, oauthProvider, oauthAllowDomain,
    oauthAllowEmail, oauthScope, webhookVerification, webhookSecret,
    mutualTlsCas, metadata, description, name, inspect, trafficPolicyFile
  }) => {
    try {
      const args: string[] = ["http", String(port)];
      
      if (url) args.push(`--url=${url}`);
      if (subdomain) args.push(`--subdomain=${subdomain}`);
      if (domain) args.push(`--domain=${domain}`);
      if (basicAuth) args.push(`--basic-auth=${basicAuth}`);
      if (hostHeader) args.push(`--host-header=${hostHeader}`);
      if (requestHeaderAdd) args.push(`--request-header-add=${requestHeaderAdd}`);
      if (responseHeaderAdd) args.push(`--response-header-add=${responseHeaderAdd}`);
      if (compression) args.push("--compression");
      if (cidrAllow) args.push(`--cidr-allow=${cidrAllow}`);
      if (cidrDeny) args.push(`--cidr-deny=${cidrDeny}`);
      if (oauthProvider) args.push(`--oauth=${oauthProvider}`);
      if (oauthAllowDomain) args.push(`--oauth-allow-domain=${oauthAllowDomain}`);
      if (oauthAllowEmail) args.push(`--oauth-allow-email=${oauthAllowEmail}`);
      if (oauthScope) args.push(`--oauth-scope=${oauthScope}`);
      if (webhookVerification) args.push(`--verify-webhook=${webhookVerification}`);
      if (webhookSecret) args.push(`--verify-webhook-secret=${webhookSecret}`);
      if (mutualTlsCas) args.push(`--mutual-tls-cas=${mutualTlsCas}`);
      if (metadata) args.push(`--metadata=${metadata}`);
      if (description) args.push(`--description=${description}`);
      if (name) args.push(`--name=${name}`);
      if (inspect === false) args.push("--inspect=false");
      if (trafficPolicyFile) args.push(`--traffic-policy-file=${trafficPolicyFile}`);
      
      const output = await runNgrok(args);
      
      const urlMatch = output.match(/url=([^\s]+)/);
      const idMatch = output.match(/id=([^\s]+)/);
      
      const tunnelUrl = urlMatch ? urlMatch[1] : "Unknown";
      const id = idMatch ? idMatch[1] : "Unknown";
      
      tunnels.set(id, {
        id,
        url: tunnelUrl,
        proto: "http",
        config: { port, url, subdomain, domain, basicAuth, hostHeader, requestHeaderAdd, responseHeaderAdd, compression, cidrAllow, cidrDeny, oauthProvider, oauthAllowDomain, oauthAllowEmail, oauthScope, webhookVerification, webhookSecret, mutualTlsCas, metadata, description, name, inspect, trafficPolicyFile },
      });
      
      let text = `✅ **Túnel HTTP Criado**\n\n`;
      text += `🔗 ${tunnelUrl}\n`;
      text += `🚪 Porta: ${port}\n`;
      if (basicAuth) text += `🔐 Basic Auth: Enabled\n`;
      if (oauthProvider) text += `🔐 OAuth: ${oauthProvider}\n`;
      if (compression) text += `🗜️ Compressão: Enabled\n`;
      if (cidrAllow) text += `🔒 CIDR Allow: ${cidrAllow}\n`;
      if (mutualTlsCas) text += `🔐 mTLS: Enabled\n`;
      text += `🆔 ID: ${id}`;
      
      return { content: [{ type: "text", text }] };
    } catch (error) {
      return {
        content: [{
          type: "text",
          text: `❌ Erro ao criar túnel HTTP: ${error instanceof Error ? error.message : "Erro desconhecido"}`,
        }],
      };
    }
  }
);

server.tool(
  "ngrok_tcp",
  "Cria um túnel TCP com opções avançadas",
  {
    port: z.number().describe("Porta local"),
    url: z.string().optional().describe("URL específica do endpoint TCP"),
    remotePort: z.number().optional().describe("Porta remota específica (requer plano pago)"),
    cidrAllow: z.string().optional().describe("Permitir CIDRs específicos"),
    cidrDeny: z.string().optional().describe("Bloquear CIDRs específicos"),
    metadata: z.string().optional().describe("Metadados customizados (JSON)"),
    description: z.string().optional().describe("Descrição do endpoint"),
    name: z.string().optional().describe("Nome do endpoint"),
    trafficPolicyFile: z.string().optional().describe("Path para arquivo de traffic policy"),
  },
  async ({ port, url, remotePort, cidrAllow, cidrDeny, metadata, description, name, trafficPolicyFile }) => {
    try {
      const args: string[] = ["tcp", String(port)];
      
      if (url) args.push(`--url=${url}`);
      if (remotePort) args.push(`--remote-port=${remotePort}`);
      if (cidrAllow) args.push(`--cidr-allow=${cidrAllow}`);
      if (cidrDeny) args.push(`--cidr-deny=${cidrDeny}`);
      if (metadata) args.push(`--metadata=${metadata}`);
      if (description) args.push(`--description=${description}`);
      if (name) args.push(`--name=${name}`);
      if (trafficPolicyFile) args.push(`--traffic-policy-file=${trafficPolicyFile}`);
      
      const output = await runNgrok(args);
      
      const urlMatch = output.match(/url=([^\s]+)/);
      const idMatch = output.match(/id=([^\s]+)/);
      
      const tunnelUrl = urlMatch ? urlMatch[1] : "Unknown";
      const id = idMatch ? idMatch[1] : "Unknown";
      
      tunnels.set(id, {
        id,
        url: tunnelUrl,
        proto: "tcp",
        config: { port, url, remotePort, cidrAllow, cidrDeny, metadata, description, name, trafficPolicyFile },
      });
      
      let text = `✅ **Túnel TCP Criado**\n\n`;
      text += `🔗 ${tunnelUrl}\n`;
      text += `🚪 Porta Local: ${port}\n`;
      if (remotePort) text += `🌐 Porta Remota: ${remotePort}\n`;
      if (cidrAllow) text += `🔒 CIDR Allow: ${cidrAllow}\n`;
      text += `🆔 ID: ${id}`;
      
      return { content: [{ type: "text", text }] };
    } catch (error) {
      return {
        content: [{
          type: "text",
          text: `❌ Erro ao criar túnel TCP: ${error instanceof Error ? error.message : "Erro desconhecido"}`,
        }],
      };
    }
  }
);

server.tool(
  "ngrok_tls",
  "Cria um túnel TLS com opções avançadas",
  {
    port: z.number().describe("Porta local"),
    url: z.string().optional().describe("URL específica do endpoint TLS"),
    crt: z.string().optional().describe("Path para certificado TLS"),
    key: z.string().optional().describe("Path para chave TLS"),
    mutualTlsCas: z.string().optional().describe("Path para CA cert para mTLS (verificar clientes)"),
    cidrAllow: z.string().optional().describe("Permitir CIDRs específicos"),
    cidrDeny: z.string().optional().describe("Bloquear CIDRs específicos"),
    metadata: z.string().optional().describe("Metadados customizados (JSON)"),
    description: z.string().optional().describe("Descrição do endpoint"),
    name: z.string().optional().describe("Nome do endpoint"),
    trafficPolicyFile: z.string().optional().describe("Path para arquivo de traffic policy"),
  },
  async ({ port, url, crt, key, mutualTlsCas, cidrAllow, cidrDeny, metadata, description, name, trafficPolicyFile }) => {
    try {
      const args: string[] = ["tls", String(port)];
      
      if (url) args.push(`--url=${url}`);
      if (crt) args.push(`--crt=${crt}`);
      if (key) args.push(`--key=${key}`);
      if (mutualTlsCas) args.push(`--mutual-tls-cas=${mutualTlsCas}`);
      if (cidrAllow) args.push(`--cidr-allow=${cidrAllow}`);
      if (cidrDeny) args.push(`--cidr-deny=${cidrDeny}`);
      if (metadata) args.push(`--metadata=${metadata}`);
      if (description) args.push(`--description=${description}`);
      if (name) args.push(`--name=${name}`);
      if (trafficPolicyFile) args.push(`--traffic-policy-file=${trafficPolicyFile}`);
      
      const output = await runNgrok(args);
      
      const urlMatch = output.match(/url=([^\s]+)/);
      const idMatch = output.match(/id=([^\s]+)/);
      
      const tunnelUrl = urlMatch ? urlMatch[1] : "Unknown";
      const id = idMatch ? idMatch[1] : "Unknown";
      
      tunnels.set(id, {
        id,
        url: tunnelUrl,
        proto: "tls",
        config: { port, url, crt, key, mutualTlsCas, cidrAllow, cidrDeny, metadata, description, name, trafficPolicyFile },
      });
      
      let text = `✅ **Túnel TLS Criado**\n\n`;
      text += `🔗 ${tunnelUrl}\n`;
      text += `🚪 Porta Local: ${port}\n`;
      if (crt) text += `📜 Certificado: ${crt}\n`;
      if (mutualTlsCas) text += `🔐 mTLS (client cert): Enabled\n`;
      if (cidrAllow) text += `🔒 CIDR Allow: ${cidrAllow}\n`;
      text += `🆔 ID: ${id}`;
      
      return { content: [{ type: "text", text }] };
    } catch (error) {
      return {
        content: [{
          type: "text",
          text: `❌ Erro ao criar túnel TLS: ${error instanceof Error ? error.message : "Erro desconhecido"}`,
        }],
      };
    }
  }
);

server.tool(
  "ngrok_start",
  "Inicia túneis definidos no arquivo de configuração",
  {
    tunnels: z.string().describe("Nomes dos túneis para iniciar (separados por espaço) ou --all para todos"),
    all: z.boolean().optional().describe("Iniciar todos os túneis do config"),
    config: z.string().optional().describe("Path para arquivo de configuração específico"),
  },
  async ({ tunnels: tunnelNames, all, config }) => {
    try {
      const args: string[] = ["start"];
      
      if (all) {
        args.push("--all");
      } else if (tunnelNames) {
        args.push(...tunnelNames.trim().split(/\s+/).map((n) => positional(n, "Nome de túnel")));
      } else {
        return {
          content: [{ type: "text", text: "❌ Especifique nomes de túneis ou use --all" }],
        };
      }
      
      if (config) args.push(`--config=${config}`);
      
      const output = await runNgrok(args);
      
      let text = `✅ **Túneis Iniciados**\n\n`;
      text += output;
      
      return { content: [{ type: "text", text }] };
    } catch (error) {
      return {
        content: [{
          type: "text",
          text: `❌ Erro ao iniciar túneis: ${error instanceof Error ? error.message : "Erro desconhecido"}`,
        }],
      };
    }
  }
);

server.tool(
  "ngrok_diagnose",
  "Diagnostica problemas de conectividade com o ngrok",
  {
    region: z.string().optional().describe("Região do servidor (auto, us, eu, au, ap, sa, jp, in, us-cal-1, eu-lon-1)"),
    ipv6: z.boolean().optional().describe("Testar conectividade IPv6"),
    writeReport: z.string().optional().describe("Salvar relatório em arquivo JSON"),
  },
  async ({ region, ipv6, writeReport }) => {
    try {
      const args: string[] = ["diagnose"];
      
      if (region) args.push(`--region=${region}`);
      if (ipv6) args.push("--ipv6");
      if (writeReport) args.push(`--write-report=${writeReport}`);
      
      const output = await runNgrok(args);
      
      const isOk = output.includes("connectivity OK") || output.includes("success");
      
      let text = isOk 
        ? `✅ **Diagnóstico OK**\n\n${output}`
        : `⚠️ **Problemas Detectados**\n\n${output}`;
      
      return { content: [{ type: "text", text }] };
    } catch (error) {
      return {
        content: [{
          type: "text",
          text: `❌ Erro ao diagnosticar: ${error instanceof Error ? error.message : "Erro desconhecido"}`,
        }],
      };
    }
  }
);

server.tool(
  "ngrok_update",
  "Atualiza o ngrok para a última versão",
  {
    channel: z.enum(["stable", "beta", "unstable"]).optional().describe("Canal de atualização (default: stable)"),
  },
  async ({ channel }) => {
    try {
      const args: string[] = ["update"];
      
      if (channel) args.push(`--channel=${channel}`);
      
      const output = await runNgrok(args);
      
      let text = `✅ **ngrok Atualizado**\n\n`;
      text += output;
      
      return { content: [{ type: "text", text }] };
    } catch (error) {
      return {
        content: [{
          type: "text",
          text: `❌ Erro ao atualizar: ${error instanceof Error ? error.message : "Erro desconhecido"}`,
        }],
      };
    }
  }
);

server.tool(
  "ngrok_config_check",
  "Valida o arquivo de configuração do ngrok",
  {
    config: z.string().optional().describe("Path para arquivo de configuração específico"),
  },
  async ({ config }) => {
    try {
      const args: string[] = ["config", "check"];
      
      if (config) args.push(`--config=${config}`);
      
      const output = await runNgrok(args);
      
      const isValid = output.includes("valid") || output.includes("OK");
      
      let text = isValid
        ? `✅ **Configuração Válida**\n\n${output}`
        : `⚠️ **Problemas na Configuração**\n\n${output}`;
      
      return { content: [{ type: "text", text }] };
    } catch (error) {
      return {
        content: [{
          type: "text",
          text: `❌ Erro ao validar config: ${error instanceof Error ? error.message : "Erro desconhecido"}`,
        }],
      };
    }
  }
);

server.tool(
  "ngrok_config_edit",
  "Abre o arquivo de configuração para edição",
  {},
  async () => {
    try {
      const output = await runNgrok(["config", "edit"]);
      
      return { content: [{ type: "text", text: `📝 **Configuração**\n\n${output}` }] };
    } catch (error) {
      return {
        content: [{
          type: "text",
          text: `❌ Erro ao editar config: ${error instanceof Error ? error.message : "Erro desconhecido"}`,
        }],
      };
    }
  }
);

server.tool(
  "ngrok_kill_all",
  "Desconecta todos os túneis ativos",
  {},
  async () => {
    try {
      await runNgrok(["disconnect", "--all"]);
      tunnels.clear();
      
      return {
        content: [{
          type: "text",
          text: "✅ **Todos os túneis desconectados**",
        }],
      };
    } catch (error) {
      return {
        content: [{
          type: "text",
          text: `❌ Erro ao desconectar túneis: ${error instanceof Error ? error.message : "Erro desconhecido"}`,
        }],
      };
    }
  }
);

server.tool(
  "ngrok_inspect",
  "Mostra detalhes de um túnel específico",
  {
    tunnelId: z.string().optional().describe("ID do túnel"),
    url: z.string().optional().describe("URL do túnel (alternativa ao ID)"),
  },
  async ({ tunnelId, url }) => {
    try {
      let targetId = tunnelId;
      
      if (!targetId && url) {
        for (const [id, tunnel] of tunnels) {
          if (tunnel.url === url) {
            targetId = id;
            break;
          }
        }
      }
      
      if (!targetId) {
        return {
          content: [{ type: "text", text: "❌ Túnel não encontrado." }],
        };
      }
      
      const output = await runNgrok(["inspect", positional(targetId, "ID do túnel")]);
      
      return { content: [{ type: "text", text: `📋 **Detalhes do Túnel**\n\n${output}` }] };
    } catch (error) {
      return {
        content: [{
          type: "text",
          text: `❌ Erro ao inspecionar: ${error instanceof Error ? error.message : "Erro desconhecido"}`,
        }],
      };
    }
  }
);

server.tool(
  "ngrok_logs",
  "Mostra os logs de requisições do túnel",
  {
    tunnelId: z.string().optional().describe("ID do túnel"),
    url: z.string().optional().describe("URL do túnel (alternativa ao ID)"),
    limit: z.number().optional().describe("Número de requisições para mostrar (default: 50)"),
  },
  async ({ tunnelId, url, limit }) => {
    try {
      let targetId = tunnelId;
      
      if (!targetId && url) {
        for (const [id, tunnel] of tunnels) {
          if (tunnel.url === url) {
            targetId = id;
            break;
          }
        }
      }
      
      if (!targetId) {
        return {
          content: [{ type: "text", text: "❌ Túnel não encontrado." }],
        };
      }
      
      const output = await runNgrok(["inspect", positional(targetId, "ID do túnel"), `--limit=${limit || 50}`]);
      
      return { content: [{ type: "text", text: `📜 **Logs do Túnel**\n\n${output}` }] };
    } catch (error) {
      return {
        content: [{
          type: "text",
          text: `❌ Erro ao buscar logs: ${error instanceof Error ? error.message : "Erro desconhecido"}`,
        }],
      };
    }
  }
);

server.tool(
  "ngrok_api",
  "Executa comandos da API do ngrok agent",
  {
    endpoint: z.string().describe("Endpoint da API (ex: /api/tunnels)"),
  },
  async ({ endpoint }) => {
    try {
      const output = await runNgrok(["api", ...endpoint.trim().split(/\s+/)]);
      
      let text = `📡 **API Response**\n\n`;
      try {
        const json = JSON.parse(output);
        text += JSON.stringify(json, null, 2);
      } catch {
        text += output;
      }
      
      return { content: [{ type: "text", text }] };
    } catch (error) {
      return {
        content: [{
          type: "text",
          text: `❌ Erro na API: ${error instanceof Error ? error.message : "Erro desconhecido"}`,
        }],
      };
    }
  }
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main();
