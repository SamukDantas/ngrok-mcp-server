import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import fs from "fs";
import path from "path";
import os from "os";
import readline from "readline";
import { execFile, spawn, spawnSync, type ChildProcess } from "child_process";
import { promisify } from "util";
import { fileURLToPath } from "url";

const execFileAsync = promisify(execFile);

interface NgrokConfig {
  authtoken: string;
  ngrokPath: string;
}

interface TunnelInfo {
  id: string;
  url: string;
  proto: string;
  /** Nome do túnel no agente: `command_line`, ou o nome no arquivo de configuração. */
  nome: string;
  /** Endereço da API local do agente que mantém o túnel (ex.: 127.0.0.1:4040). */
  webAddr?: string;
  /** Processo do agente ngrok; o túnel existe enquanto ele estiver rodando. */
  processo: ChildProcess;
  config: Record<string, unknown>;
}

const tunnels: Map<string, TunnelInfo> = new Map();
let proximoId = 1;

const raizDoProjeto = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const nomeDoBinario = process.platform === "win32" ? "ngrok.exe" : "ngrok";
const TEMPO_PARA_ABRIR_MS = 30_000;

function configPath(): string {
  return path.join(os.homedir(), ".config", "opencode", "ngrok-config.json");
}

/** Conteúdo de ngrok-config.json, se existir. Ausente: o ngrok usa a própria configuração. */
function loadConfig(): Partial<NgrokConfig> {
  const file = configPath();
  if (!fs.existsSync(file)) return {};
  const config: unknown = JSON.parse(fs.readFileSync(file, "utf-8"));
  if (typeof config !== "object" || config === null) return {};
  const { authtoken, ngrokPath } = config as Record<string, unknown>;
  return {
    authtoken: typeof authtoken === "string" && authtoken ? authtoken : undefined,
    ngrokPath: typeof ngrokPath === "string" && ngrokPath ? ngrokPath : undefined,
  };
}

/** Procura o executável do ngrok no PATH. */
function ngrokNoPath(): string | undefined {
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!dir) continue;
    const candidato = path.join(dir, nomeDoBinario);
    if (fs.existsSync(candidato)) return candidato;
  }
  return undefined;
}

/**
 * Qual executável roda o ngrok, nesta ordem:
 * 1. `NGROK_MCP_RUNNER` (script .js que substitui o ngrok nos testes);
 * 2. `NGROK_BIN` ou `ngrokPath` no ngrok-config.json;
 * 3. `bin/ngrok(.exe)` dentro do projeto (ignorado pelo git);
 * 4. o `ngrok` do PATH;
 * 5. `npx ngrok`. No Windows o `npx` é um .cmd, que o Node só executa via
 *    shell; por isso o `npx-cli.js` do npm é chamado pelo próprio Node.
 */
function ngrokCommand(): { command: string; prefix: string[] } {
  const runner = process.env.NGROK_MCP_RUNNER;
  if (runner) return { command: process.execPath, prefix: [runner, "ngrok"] };

  const local = path.join(raizDoProjeto, "bin", nomeDoBinario);
  const bin = process.env.NGROK_BIN || loadConfig().ngrokPath || (fs.existsSync(local) ? local : undefined) || ngrokNoPath();
  if (bin) return { command: bin, prefix: [] };

  if (process.platform !== "win32") return { command: "npx", prefix: ["ngrok"] };
  const cli = path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npx-cli.js");
  return { command: process.execPath, prefix: [cli, "ngrok"] };
}

/** Variáveis de ambiente do ngrok: o authtoken do arquivo vai por NGROK_AUTHTOKEN. */
function ngrokEnv(): NodeJS.ProcessEnv {
  const { authtoken } = loadConfig();
  return authtoken ? { ...process.env, NGROK_AUTHTOKEN: authtoken } : process.env;
}

/**
 * Executa um comando curto do ngrok (`version`, `config check`...) SEM shell:
 * cada argumento é passado como está, então valores vindos do modelo não podem
 * injetar comandos. O authtoken vai por variável de ambiente, não por argumento,
 * para não aparecer na lista de processos.
 */
async function runNgrok(args: string[]): Promise<string> {
  const { command, prefix } = ngrokCommand();
  try {
    const { stdout, stderr } = await execFileAsync(command, [...prefix, ...args], {
      encoding: "utf-8",
      maxBuffer: 10 * 1024 * 1024,
      windowsHide: true,
      env: ngrokEnv(),
    });
    return stdout || stderr;
  } catch (error: unknown) {
    const err = error as { message?: string; stdout?: string; stderr?: string };
    return err.stdout || err.stderr || err.message || "Unknown error";
  }
}

interface AgenteIniciado {
  processo: ChildProcess;
  webAddr?: string;
  tuneis: { nome: string; url: string }[];
}

/**
 * Sobe um agente ngrok (`ngrok http|tcp|tls|start ...`), que fica rodando enquanto
 * o túnel existir, e espera o log JSON anunciar os túneis abertos. Também sem shell.
 * `esperados` é quantos túneis aguardar; sem ele (`start --all`), conclui quando o
 * log fica quieto depois do primeiro túnel.
 */
function iniciarAgente(args: string[], esperados?: number): Promise<AgenteIniciado> {
  const { command, prefix } = ngrokCommand();
  const processo = spawn(command, [...prefix, ...args, "--log=stdout", "--log-format=json"], {
    env: ngrokEnv(),
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });

  return new Promise((resolve, reject) => {
    const tuneis: AgenteIniciado["tuneis"] = [];
    const erros: string[] = [];
    let stderr = "";
    let webAddr: string | undefined;
    let quieto: NodeJS.Timeout | undefined;
    let concluido = false;

    const detalhes = () => {
      const texto = [...new Set([...erros, stderr.trim()])].filter(Boolean).join("; ") || "sem detalhes";
      return /certificate signed by unknown authority/.test(texto)
        ? `${texto}. Um antivírus ou proxy está interceptando o TLS do ngrok: exclua o ngrok (connect.ngrok-agent.com) da inspeção HTTPS.`
        : texto;
    };
    const concluir = (erro?: Error) => {
      if (concluido) return;
      concluido = true;
      clearTimeout(limite);
      clearTimeout(quieto);
      if (erro) {
        matar(processo);
        reject(erro);
      } else {
        resolve({ processo, webAddr, tuneis });
      }
    };
    const limite = setTimeout(
      () => concluir(new Error(`o ngrok não abriu o túnel em ${TEMPO_PARA_ABRIR_MS / 1000}s: ${detalhes()}`)),
      TEMPO_PARA_ABRIR_MS,
    );

    readline.createInterface({ input: processo.stdout! }).on("line", (linha) => {
      let log: Record<string, unknown>;
      try {
        log = JSON.parse(linha);
      } catch {
        if (linha.trim()) erros.push(linha.trim());
        return;
      }
      if (log.obj === "web" && typeof log.addr === "string") webAddr = log.addr;
      if ((log.lvl === "eror" || log.lvl === "crit") && typeof log.err === "string") erros.push(log.err);
      if (log.msg === "started tunnel" && typeof log.url === "string") {
        tuneis.push({ nome: typeof log.name === "string" ? log.name : "command_line", url: log.url });
        if (esperados !== undefined) {
          if (tuneis.length >= esperados) concluir();
        } else {
          clearTimeout(quieto);
          quieto = setTimeout(() => concluir(), 1500);
        }
      }
    });
    processo.stderr!.on("data", (d) => {
      stderr += d;
    });
    processo.on("error", (e) => concluir(e));
    processo.on("exit", (code) => concluir(new Error(`o ngrok encerrou (código ${code}) antes de abrir o túnel: ${detalhes()}`)));
  });
}

/** Encerra o agente. No Windows, derruba a árvore toda (o `npx` deixaria o ngrok órfão). */
function matar(processo: ChildProcess): void {
  if (processo.exitCode !== null || processo.pid === undefined) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(processo.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
  } else {
    processo.kill();
  }
}

function protoDaUrl(url: string): string {
  const esquema = url.split("://")[0];
  return esquema === "https" ? "http" : esquema;
}

/** Registra os túneis de um agente; eles saem da lista quando o agente termina. */
function registrar(agente: AgenteIniciado, config: Record<string, unknown>, proto?: string): TunnelInfo[] {
  const criados = agente.tuneis.map((t) => {
    const info: TunnelInfo = {
      id: `t${proximoId++}`,
      url: t.url,
      proto: proto ?? protoDaUrl(t.url),
      nome: t.nome,
      webAddr: agente.webAddr,
      processo: agente.processo,
      config,
    };
    tunnels.set(info.id, info);
    return info;
  });
  agente.processo.on("exit", () => {
    for (const t of criados) tunnels.delete(t.id);
  });
  return criados;
}

async function abrirTunel(args: string[], proto: string, config: Record<string, unknown>): Promise<TunnelInfo> {
  const agente = await iniciarAgente(args, 1);
  return registrar(agente, config, proto)[0];
}

function encontrar(tunnelId?: string, url?: string): TunnelInfo | undefined {
  if (tunnelId) return tunnels.get(tunnelId);
  if (url) return [...tunnels.values()].find((t) => t.url === url);
  return undefined;
}

/** Encerra o agente do túnel; devolve todos os túneis que ele mantinha. */
function encerrar(alvo: TunnelInfo): TunnelInfo[] {
  const doMesmoAgente = [...tunnels.values()].filter((t) => t.processo === alvo.processo);
  matar(alvo.processo);
  for (const t of doMesmoAgente) tunnels.delete(t.id);
  return doMesmoAgente;
}

/** GET na API local do agente (a mesma da interface web em 127.0.0.1:4040). */
async function apiDoAgente(webAddr: string, caminho: string): Promise<unknown> {
  const res = await fetch(`http://${webAddr}${caminho}`, { signal: AbortSignal.timeout(10_000) });
  const corpo = await res.text();
  if (!res.ok) throw new Error(`API do agente respondeu ${res.status}: ${corpo.trim()}`);
  try {
    return JSON.parse(corpo);
  } catch {
    return corpo;
  }
}

/** Argumento posicional vindo do modelo não pode começar com "-" (seria lido como flag do ngrok). */
function positional(value: string, label: string): string {
  if (value.startsWith("-")) throw new Error(`${label} inválido: não pode começar com "-"`);
  return value;
}

const NAO_ENCONTRADO = "❌ Túnel não encontrado. Use ngrok_list_tunnels para ver os túneis ativos.";

const server = new McpServer({
  name: "ngrok",
  version: "1.0.0",
});

server.tool(
  "ngrok_list_tunnels",
  "Lista os túneis ativos abertos por este servidor",
  {},
  async () => {
    if (tunnels.size === 0) {
      return {
        content: [{ type: "text", text: "❌ Nenhum túnel ativo! Execute ngrok_connect ou ngrok_http para criar um." }],
      };
    }

    let text = `🚇 **Túneis Ativos** (${tunnels.size}):\n\n`;
    for (const [id, tunnel] of tunnels) {
      text += `• ${tunnel.url}\n`;
      text += `  Proto: ${tunnel.proto}\n`;
      text += `  ID: ${id}\n\n`;
    }

    return { content: [{ type: "text", text }] };
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
      // No ngrok v3, túneis HTTPS são criados pelo comando `http`.
      const comando = proto === "https" ? "http" : proto;
      const args: string[] = [comando, String(port)];

      if (subdomain) args.push(`--subdomain=${subdomain}`);
      if (domain) args.push(`--domain=${domain}`);
      if (auth) args.push(`--basic-auth=${auth}`);

      const tunel = await abrirTunel(args, comando, { port, subdomain, domain, auth });

      let text = `✅ **Túnel Criado**\n\n`;
      text += `🔗 ${tunel.url}\n`;
      text += `📋 Proto: ${tunel.proto}\n`;
      text += `🚪 Porta: ${port}\n`;
      text += `🆔 ID: ${tunel.id}`;

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
    const alvo = encontrar(tunnelId, url);
    if (!alvo) {
      return { content: [{ type: "text", text: NAO_ENCONTRADO }] };
    }

    const encerrados = encerrar(alvo);

    let text = `✅ **Túnel Desconectado**\n\n🆔 ID: ${alvo.id}\n🔗 ${alvo.url}`;
    const outros = encerrados.filter((t) => t.id !== alvo.id);
    if (outros.length > 0) {
      text += `\n\nO mesmo agente também mantinha: ${outros.map((t) => t.url).join(", ")} (encerrados junto).`;
    }

    return { content: [{ type: "text", text }] };
  }
);

server.tool(
  "ngrok_status",
  "Mostra o status da sessão ngrok",
  {},
  async () => {
    const output = (await runNgrok(["version"])).trim();

    if (!/ngrok version/i.test(output)) {
      return { content: [{ type: "text", text: `❌ **ngrok indisponível**\n\n${output}` }] };
    }

    let text = `📊 **Status ngrok**\n\n`;
    text += `Versão: ${output}\n`;
    text += `Authtoken em ngrok-config.json: ${loadConfig().authtoken ? "sim" : "não (usa a configuração do próprio ngrok)"}\n`;
    text += `Túneis ativos: ${tunnels.size}\n`;
    const interfaces = [...new Set([...tunnels.values()].map((t) => t.webAddr).filter(Boolean))];
    if (interfaces.length > 0) text += `Web Interface: ${interfaces.map((a) => `http://${a}`).join(", ")}`;

    return { content: [{ type: "text", text }] };
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

      const tunel = await abrirTunel(args, "http", { port, url, subdomain, domain, basicAuth, hostHeader, requestHeaderAdd, responseHeaderAdd, compression, cidrAllow, cidrDeny, oauthProvider, oauthAllowDomain, oauthAllowEmail, oauthScope, webhookVerification, webhookSecret, mutualTlsCas, metadata, description, name, inspect, trafficPolicyFile });

      let text = `✅ **Túnel HTTP Criado**\n\n`;
      text += `🔗 ${tunel.url}\n`;
      text += `🚪 Porta: ${port}\n`;
      if (basicAuth) text += `🔐 Basic Auth: Enabled\n`;
      if (oauthProvider) text += `🔐 OAuth: ${oauthProvider}\n`;
      if (compression) text += `🗜️ Compressão: Enabled\n`;
      if (cidrAllow) text += `🔒 CIDR Allow: ${cidrAllow}\n`;
      if (mutualTlsCas) text += `🔐 mTLS: Enabled\n`;
      text += `🆔 ID: ${tunel.id}`;

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

      const tunel = await abrirTunel(args, "tcp", { port, url, remotePort, cidrAllow, cidrDeny, metadata, description, name, trafficPolicyFile });

      let text = `✅ **Túnel TCP Criado**\n\n`;
      text += `🔗 ${tunel.url}\n`;
      text += `🚪 Porta Local: ${port}\n`;
      if (remotePort) text += `🌐 Porta Remota: ${remotePort}\n`;
      if (cidrAllow) text += `🔒 CIDR Allow: ${cidrAllow}\n`;
      text += `🆔 ID: ${tunel.id}`;

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

      const tunel = await abrirTunel(args, "tls", { port, url, crt, key, mutualTlsCas, cidrAllow, cidrDeny, metadata, description, name, trafficPolicyFile });

      let text = `✅ **Túnel TLS Criado**\n\n`;
      text += `🔗 ${tunel.url}\n`;
      text += `🚪 Porta Local: ${port}\n`;
      if (crt) text += `📜 Certificado: ${crt}\n`;
      if (mutualTlsCas) text += `🔐 mTLS (client cert): Enabled\n`;
      if (cidrAllow) text += `🔒 CIDR Allow: ${cidrAllow}\n`;
      text += `🆔 ID: ${tunel.id}`;

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
      let esperados: number | undefined;

      if (all || tunnelNames.trim() === "--all") {
        args.push("--all");
      } else if (tunnelNames.trim()) {
        const nomes = tunnelNames.trim().split(/\s+/).map((n) => positional(n, "Nome de túnel"));
        args.push(...nomes);
        esperados = nomes.length;
      } else {
        return {
          content: [{ type: "text", text: "❌ Especifique nomes de túneis ou use --all" }],
        };
      }

      if (config) args.push(`--config=${config}`);

      const agente = await iniciarAgente(args, esperados);
      const criados = registrar(agente, { tunnels: tunnelNames, all, config });

      let text = `✅ **Túneis Iniciados** (${criados.length})\n\n`;
      for (const t of criados) text += `• ${t.nome}: ${t.url} (ID: ${t.id})\n`;

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

      const isOk = /connectivity OK|success|no issues/i.test(output) && !/error|fail/i.test(output);

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

      const isValid = /valid configuration/i.test(output) && !/error|invalid/i.test(output);

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
  "Mostra onde ficam os arquivos de configuração, para edição",
  {},
  async () => {
    // `ngrok config edit` abre um editor interativo e travaria a chamada até ele
    // fechar; por isso a ferramenta só aponta os arquivos.
    const output = (await runNgrok(["config", "check"])).trim();
    const arquivo = output.match(/configuration file at (.+)$/im)?.[1];

    let text = `📝 **Configuração**\n\n`;
    text += arquivo ? `Arquivo do ngrok: ${arquivo}\n` : `Arquivo do ngrok: não localizado (${output})\n`;
    text += `Authtoken deste servidor: ${configPath()}\n\n`;
    text += `Edite no seu editor e valide com ngrok_config_check.`;

    return { content: [{ type: "text", text }] };
  }
);

server.tool(
  "ngrok_kill_all",
  "Desconecta todos os túneis ativos",
  {},
  async () => {
    const todos = [...tunnels.values()];
    for (const processo of new Set(todos.map((t) => t.processo))) matar(processo);
    tunnels.clear();

    return {
      content: [{
        type: "text",
        text: todos.length > 0
          ? `✅ **Todos os túneis desconectados** (${todos.length})`
          : "Nenhum túnel ativo para desconectar.",
      }],
    };
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
    const alvo = encontrar(tunnelId, url);
    if (!alvo) {
      return { content: [{ type: "text", text: NAO_ENCONTRADO }] };
    }

    let text = `📋 **Detalhes do Túnel**\n\n`;
    text += `🆔 ID: ${alvo.id}\n🔗 ${alvo.url}\n📋 Proto: ${alvo.proto}\n`;
    if (!alvo.webAddr) return { content: [{ type: "text", text }] };

    try {
      const detalhes = await apiDoAgente(alvo.webAddr, `/api/tunnels/${encodeURIComponent(alvo.nome)}`);
      text += `\n${JSON.stringify(detalhes, null, 2)}`;
    } catch (error) {
      text += `\n⚠️ Detalhes do agente indisponíveis: ${error instanceof Error ? error.message : "Erro desconhecido"}`;
    }

    return { content: [{ type: "text", text }] };
  }
);

interface RequisicaoCapturada {
  start?: string;
  duration?: number;
  request?: { method?: string; uri?: string };
  response?: { status_code?: number };
}

server.tool(
  "ngrok_logs",
  "Mostra os logs de requisições do túnel",
  {
    tunnelId: z.string().optional().describe("ID do túnel"),
    url: z.string().optional().describe("URL do túnel (alternativa ao ID)"),
    limit: z.number().optional().describe("Número de requisições para mostrar (default: 50)"),
  },
  async ({ tunnelId, url, limit }) => {
    const alvo = encontrar(tunnelId, url);
    if (!alvo) {
      return { content: [{ type: "text", text: NAO_ENCONTRADO }] };
    }
    if (!alvo.webAddr) {
      return { content: [{ type: "text", text: "❌ O agente deste túnel não expôs a API local; logs indisponíveis." }] };
    }

    try {
      const quantidade = Math.min(Math.max(Math.trunc(limit ?? 50), 1), 500);
      const dados = await apiDoAgente(
        alvo.webAddr,
        `/api/requests/http?limit=${quantidade}&tunnel_name=${encodeURIComponent(alvo.nome)}`,
      );
      const requisicoes = ((dados as { requests?: RequisicaoCapturada[] }).requests ?? []);

      if (requisicoes.length === 0) {
        return { content: [{ type: "text", text: `📜 **Logs do Túnel**\n\nNenhuma requisição capturada ainda (a inspeção só vale para túneis HTTP com inspect ativo).` }] };
      }

      let text = `📜 **Logs do Túnel** (${requisicoes.length})\n\n`;
      for (const r of requisicoes) {
        const ms = r.duration ? Math.round(r.duration / 1e6) : undefined;
        text += `• ${r.start ?? ""} ${r.request?.method ?? "?"} ${r.request?.uri ?? "?"} → ${r.response?.status_code ?? "sem resposta"}${ms !== undefined ? ` (${ms} ms)` : ""}\n`;
      }

      return { content: [{ type: "text", text }] };
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
  "Consulta a API local do agente ngrok (GET), a mesma da interface web",
  {
    endpoint: z.string().describe("Caminho na API local do agente (ex: /api/tunnels, /api/requests/http?limit=10)"),
  },
  async ({ endpoint }) => {
    try {
      // Só caminhos de leitura da API local: nada de host, esquema ou "..".
      if (!/^\/api\/[A-Za-z0-9_\-\/]*(\?[A-Za-z0-9_=&%.\-]*)?$/.test(endpoint) || endpoint.includes("..")) {
        return { content: [{ type: "text", text: "❌ Endpoint inválido: use um caminho da API local, como /api/tunnels" }] };
      }

      const webAddr = [...tunnels.values()].find((t) => t.webAddr)?.webAddr ?? "127.0.0.1:4040";
      const resposta = await apiDoAgente(webAddr, endpoint);

      let text = `📡 **API Response** (${webAddr})\n\n`;
      text += typeof resposta === "string" ? resposta : JSON.stringify(resposta, null, 2);

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

/** Os túneis morrem com o servidor: nenhum agente ngrok fica órfão expondo portas. */
function encerrarAgentes(): void {
  for (const processo of new Set([...tunnels.values()].map((t) => t.processo))) matar(processo);
}

async function main() {
  process.on("exit", encerrarAgentes);
  for (const sinal of ["SIGINT", "SIGTERM"] as const) process.on(sinal, () => process.exit(0));
  // O cliente MCP fecha o stdin ao encerrar a sessão.
  process.stdin.on("end", () => process.exit(0));

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main();
