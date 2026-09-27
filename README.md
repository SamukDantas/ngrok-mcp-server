# ngrok MCP Server

Servidor [MCP (Model Context Protocol)](https://modelcontextprotocol.io) para criar e gerenciar túneis [ngrok](https://ngrok.com) a partir de assistentes de IA: **Claude Code, Claude Desktop, OpenCode** ou qualquer cliente MCP via stdio.

- **16 ferramentas**: túneis HTTP, TCP e TLS com opções avançadas (auth básica, OAuth, restrição por IP, mTLS, traffic policy), além de listagem, inspeção, logs, diagnóstico e manutenção do agente
- TypeScript, SDK oficial do MCP e validação de parâmetros com Zod
- Usa o ngrok CLI via `npx`: não é preciso instalar o ngrok separadamente

## Índice

1. [Instalação](#instalação)
2. [Configuração](#configuração)
3. [Uso nos clientes MCP](#uso-nos-clientes-mcp)
4. [Ferramentas disponíveis](#ferramentas-disponíveis)
5. [Exemplos de uso](#exemplos-de-uso)
6. [Opções avançadas](#opções-avançadas)

## Instalação

**Pré-requisitos:** Node.js 18+ e npm, e uma conta no ngrok (gratuita ou paga).

```bash
git clone https://github.com/SamukDantas/ngrok-mcp-server.git
cd ngrok-mcp-server
npm install
npm run build
```

O build gera `dist/index.js`, que é o ponto de entrada do servidor.

## Configuração

O servidor lê o authtoken de `~/.config/opencode/ngrok-config.json` (no Windows, `C:/Users/<você>/.config/opencode/ngrok-config.json`), qualquer que seja o cliente MCP:

```json
{
  "authtoken": "SEU_AUTHTOKEN_AQUI"
}
```

Pegue o seu authtoken em https://dashboard.ngrok.com/get-started/your-authtoken.

> Este arquivo contém credenciais: não o versione. O `.gitignore` do projeto já ignora `*-config.json`.

## Uso nos clientes MCP

Nos exemplos, troque `/caminho/para` pelo diretório onde você clonou o repositório. No Windows, use barras normais (`C:/Users/...`).

### Claude Code

```bash
claude mcp add ngrok -- node /caminho/para/ngrok-mcp-server/dist/index.js
```

### Claude Desktop

Em `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "ngrok": {
      "command": "node",
      "args": ["/caminho/para/ngrok-mcp-server/dist/index.js"]
    }
  }
}
```

### OpenCode

Em `opencode.json`:

```json
{
  "mcp": {
    "ngrok": {
      "type": "local",
      "command": ["node", "/caminho/para/ngrok-mcp-server/dist/index.js"],
      "enabled": true
    }
  }
}
```

Depois de configurar, reinicie o cliente e peça ao assistente para executar `ngrok_status` para confirmar que a sessão responde.

## Ferramentas disponíveis

### Gerenciamento de túneis

| Ferramenta | Descrição |
|------------|-----------|
| `ngrok_list_tunnels` | Lista todos os túneis ativos |
| `ngrok_connect` | Cria um novo túnel (http/https/tcp/tls) |
| `ngrok_disconnect` | Desconecta um túnel pelo ID ou URL |
| `ngrok_kill_all` | Desconecta todos os túneis ativos |

### Protocolos

| Ferramenta | Descrição |
|------------|-----------|
| `ngrok_http` | Cria um túnel HTTP com opções avançadas |
| `ngrok_tcp` | Cria um túnel TCP com opções avançadas |
| `ngrok_tls` | Cria um túnel TLS com opções avançadas |

### Configuração e manutenção

| Ferramenta | Descrição |
|------------|-----------|
| `ngrok_status` | Mostra o status da sessão ngrok |
| `ngrok_start` | Inicia túneis pelo arquivo de configuração |
| `ngrok_diagnose` | Diagnostica problemas de conectividade |
| `ngrok_update` | Atualiza o ngrok para a última versão |
| `ngrok_config_check` | Valida o arquivo de configuração |
| `ngrok_config_edit` | Abre o arquivo de configuração para edição |

### Inspeção

| Ferramenta | Descrição |
|------------|-----------|
| `ngrok_inspect` | Mostra detalhes de um túnel específico |
| `ngrok_logs` | Mostra os logs de requisições do túnel |
| `ngrok_api` | Executa comandos da API do agente ngrok |

## Exemplos de uso

Cada exemplo mostra o nome da ferramenta seguido dos argumentos JSON. Na prática, basta pedir ao assistente em linguagem natural ("abre um túnel HTTP para a porta 3000 com senha"), e ele escolhe a ferramenta e os argumentos.

```text
# Túnel HTTP básico
ngrok_http {"port": 3000}

# Túnel HTTP com autenticação básica
ngrok_http {"port": 3000, "basicAuth": "usuario:senha"}

# Túnel HTTP protegido por OAuth
ngrok_http {"port": 8080, "oauthProvider": "google", "oauthAllowDomain": "exemplo.com", "oauthScope": "email,profile"}

# Túnel HTTP com restrição por IP
ngrok_http {"port": 3000, "cidrAllow": "192.168.1.0/24", "cidrDeny": "10.0.0.0/8"}

# Túnel TCP
ngrok_tcp {"port": 22}

# Túnel TLS com certificado próprio
ngrok_tls {"port": 443, "crt": "/caminho/cert.crt", "key": "/caminho/key.key"}

# Listar e desconectar túneis
ngrok_list_tunnels {}
ngrok_disconnect {"url": "https://abc123.ngrok.io"}

# Diagnóstico de conectividade
ngrok_diagnose {"region": "us"}
```

## Opções avançadas

### ngrok_http

| Parâmetro | Tipo | Descrição |
|-----------|------|-----------|
| `port` | number | **Obrigatório**. Porta local |
| `url` | string | URL específica do endpoint |
| `subdomain` | string | Subdomínio (requer plano pago) |
| `domain` | string | Domínio customizado (requer plano pago) |
| `basicAuth` | string | Auth básica (`usuario:senha`) |
| `hostHeader` | string | Host header para roteamento |
| `requestHeaderAdd` | string | Adiciona header na requisição |
| `responseHeaderAdd` | string | Adiciona header na resposta |
| `compression` | boolean | Habilita compressão gzip |
| `cidrAllow` | string | Permite CIDRs específicos |
| `cidrDeny` | string | Bloqueia CIDRs específicos |
| `oauthProvider` | string | Provedor OAuth (google, github, microsoft, slack) |
| `oauthAllowDomain` | string | Domínios permitidos no OAuth |
| `oauthAllowEmail` | string | E-mails permitidos no OAuth |
| `oauthScope` | string | Scopes OAuth (separados por vírgula) |
| `webhookVerification` | string | Verificação de webhook |
| `webhookSecret` | string | Secret do webhook |
| `mutualTlsCas` | string | Caminho para o certificado da CA (mTLS) |
| `metadata` | string | Metadados customizados (JSON) |
| `description` | string | Descrição do endpoint |
| `name` | string | Nome do endpoint |
| `inspect` | boolean | Habilita a inspeção HTTP |
| `trafficPolicyFile` | string | Caminho para o arquivo de traffic policy |

### ngrok_tls

| Parâmetro | Tipo | Descrição |
|-----------|------|-----------|
| `port` | number | **Obrigatório**. Porta local |
| `url` | string | URL específica do endpoint TLS |
| `crt` | string | Caminho para o certificado TLS |
| `key` | string | Caminho para a chave TLS |
| `mutualTlsCas` | string | Caminho para o certificado da CA (mTLS) |
| `cidrAllow` | string | Permite CIDRs específicos |
| `cidrDeny` | string | Bloqueia CIDRs específicos |
| `metadata` | string | Metadados customizados |
| `description` | string | Descrição do endpoint |
| `name` | string | Nome do endpoint |
| `trafficPolicyFile` | string | Caminho para o arquivo de traffic policy |

## Segurança

Os argumentos das ferramentas vêm do modelo, então são tratados como entrada não confiável. O ngrok é executado sem shell (`execFile` com lista de argumentos): cada valor chega ao ngrok como um único argumento literal, e aspas, `;`, `&`, `$()` ou crases não executam nada. IDs e nomes de túnel que começam com `-` são recusados, para não serem lidos como flags. O authtoken é passado ao ngrok pela variável `NGROK_AUTHTOKEN`, nunca pela linha de comando.

## Desenvolvimento

```bash
npm test
```

Compila e roda os testes: o servidor sobe de verdade via stdio, com um ngrok falso no lugar do `npx`, e os testes verificam o argv recebido.

## Licença

[MIT](LICENSE) © 2026 Samuel Dantas
