# ngrok MCP Server

Servidor MCP (Model Context Protocol) para gerenciar túneis ngrok diretamente do OpenCode ou outros clientes MCP.

## Instalação

```bash
# Clone o repositório
git clone https://github.com/SamukDantas/ngrok-mcp-server.git
cd ngrok-mcp-server

# Instale as dependências
npm install

# Compile o TypeScript
npm run build
```

## Configuração

### 1. Configure o authtoken do ngrok

Crie um arquivo `ngrok-config.json` no diretório `~/.config/opencode/`:

```json
{
  "authtoken": "SEU_AUTHTOKEN_AQUI"
}
```

Para obter seu authtoken, vá em: https://dashboard.ngrok.com/get-started/your-authtoken

### 2. Configure o OpenCode

Adicione o MCP do ngrok no seu `opencode.json`:

```json
{
  "mcpServers": {
    "ngrok": {
      "command": "node",
      "args": ["C:/Users/SamukDantas/.config/opencode/mcp-servers/ngrok/dist/index.js"]
    }
  }
}
```

## Ferramentas Disponíveis

### Gerenciamento de Túneis

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

### Configuração e Manutenção

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
| `ngrok_api` | Executa comandos da API do ngrok agent |

## Exemplos de Uso

### Criar um túnel HTTP básico

```javascript
await ngrok_http({ port: 3000 });
```

### Criar um túnel HTTP com autenticação

```javascript
await ngrok_http({
  port: 3000,
  basicAuth: "user:password"
});
```

### Criar um túnel com OAuth

```javascript
await ngrok_http({
  port: 8080,
  oauthProvider: "google",
  oauthAllowDomain: "exemplo.com",
  oauthScope: "email,profile"
});
```

### Cri

```javascript
ar um túnel TCPawait ngrok_tcp({ port: 22 });
```

### Criar um túnel TLS com certificado

```javascript
await ngrok_tls({
  port: 443,
  crt: "/path/to/cert.crt",
  key: "/path/to/key.key"
});
```

### Criar um túnel com IP restriction

```javascript
await ngrok_http({
  port: 3000,
  cidrAllow: "192.168.1.0/24",
  cidrDeny: "10.0.0.0/8"
});
```

### Listar túneis ativos

```javascript
await ngrok_list_tunnels();
```

### Desconectar um túnel

```javascript
await ngrok_disconnect({ url: "https://abc123.ngrok.io" });
```

### Diagnóstico de conectividade

```javascript
await ngrok_diagnose({ region: "us" });
```

## Opções Avançadas

### ngrok_http

| Parâmetro | Tipo | Descrição |
|-----------|------|-----------|
| `port` | number | **Obrigatório**. Porta local |
| `url` | string | URL específica do endpoint |
| `subdomain` | string | Subdomínio (requer plano pago) |
| `domain` | string | Domínio customizado (requer plano pago) |
| `basicAuth` | string | Auth básico (user:pass) |
| `hostHeader` | string | Host header para roteamento |
| `requestHeaderAdd` | string | Adicionar header na requisição |
| `responseHeaderAdd` | string | Adicionar header na resposta |
| `compression` | boolean | Habilitar compressão gzip |
| `cidrAllow` | string | Permitir CIDRs específicos |
| `cidrDeny` | string | Bloquear CIDRs específicos |
| `oauthProvider` | string | Provedor OAuth (google, github, microsoft, slack) |
| `oauthAllowDomain` | string | Domínios permitidos no OAuth |
| `oauthAllowEmail` | string | Emails permitidos no OAuth |
| `oauthScope` | string | Scopes OAuth (comma-separated) |
| `webhookVerification` | string | Verificação de webhook |
| `webhookSecret` | string | Secret do webhook |
| `mutualTlsCas` | string | Path para CA cert para mTLS |
| `metadata` | string | Metadados customizados (JSON) |
| `description` | string | Descrição do endpoint |
| `name` | string | Nome do endpoint |
| `inspect` | boolean | Habilitar inspeção HTTP |
| `trafficPolicyFile` | string | Path para arquivo de traffic policy |

### ngrok_tls

| Parâmetro | Tipo | Descrição |
|-----------|------|-----------|
| `port` | number | **Obrigatório**. Porta local |
| `url` | string | URL específica do endpoint TLS |
| `crt` | string | Path para certificado TLS |
| `key` | string | Path para chave TLS |
| `mutualTlsCas` | string | Path para CA cert para mTLS |
| `cidrAllow` | string | Permitir CIDRs específicos |
| `cidrDeny` | string | Bloquear CIDRs específicos |
| `metadata` | string | Metadados customizados |
| `description` | string | Descrição do endpoint |
| `name` | string | Nome do endpoint |
| `trafficPolicyFile` | string | Path para traffic policy |

## Requisitos

- Node.js 18+
- npm ou yarn
- ngrok CLI (instalado automaticamente via npx)
- Conta no ngrok (gratuita ou paga)

## Licença

MIT
