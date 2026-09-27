// O servidor roda de verdade (dist/index.js, via stdio), mas o ngrok é trocado por
// um script que registra o argv e imita o log do agente; a API local do agente é
// imitada por um servidor HTTP do próprio teste.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const raiz = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ngrok-mcp-test-"));
const log = path.join(tmp, "argv.jsonl");
const home = path.join(tmp, "home");
const AUTHTOKEN_FALSO = "token-de-teste";
const FIM = ["--log=stdout", "--log-format=json"];

// Interpolado como `--basic-auth="${valor}"` (o código antigo), fecha as aspas e
// cria pwned.txt tanto em sh quanto em cmd; os demais cobrem $() e crases no sh.
const PAYLOAD = `a:b" & echo pwned > pwned.txt & echo "; touch pwned; $(touch pwned2) \`touch pwned3\``;

let client;
let agenteFalso;
const caminhosPedidos = [];

async function conectar() {
  const c = new Client({ name: "teste", version: "1.0.0" });
  await c.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [path.join(raiz, "dist", "index.js")],
      cwd: tmp,
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        NGROK_MCP_RUNNER: path.join(raiz, "tests", "fixtures", "ngrok-falso.mjs"),
        NGROK_FALSO_LOG: log,
        NGROK_FALSO_WEB: `127.0.0.1:${agenteFalso.address().port}`,
      },
    }),
  );
  return c;
}

before(async () => {
  fs.mkdirSync(path.join(home, ".config", "opencode"), { recursive: true });
  fs.writeFileSync(
    path.join(home, ".config", "opencode", "ngrok-config.json"),
    JSON.stringify({ authtoken: AUTHTOKEN_FALSO }),
  );
  // Imita a API local do agente (a da interface web em 127.0.0.1:4040).
  agenteFalso = http.createServer((req, res) => {
    caminhosPedidos.push(req.url);
    res.setHeader("content-type", "application/json");
    if (req.url.startsWith("/api/requests/http")) {
      res.end(JSON.stringify({ requests: [{ start: "2026-09-27T12:00:00Z", duration: 12e6, request: { method: "GET", uri: "/ola" }, response: { status_code: 200 } }] }));
    } else {
      res.end(JSON.stringify({ tunnels: [], uri: req.url }));
    }
  });
  await new Promise((r) => agenteFalso.listen(0, "127.0.0.1", r));
  client = await conectar();
});

after(async () => {
  await client?.close();
  agenteFalso?.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

function chamadas() {
  if (!fs.existsSync(log)) return [];
  return fs.readFileSync(log, "utf-8").trim().split("\n").map((l) => JSON.parse(l));
}

function ultimaChamada() {
  const todas = chamadas();
  assert.ok(todas.length > 0, "o ngrok falso não foi chamado");
  return todas.at(-1);
}

function nadaFoiExecutado() {
  for (const f of ["pwned", "pwned.txt", "pwned2", "pwned3"]) {
    assert.equal(fs.existsSync(path.join(tmp, f)), false, `${f} foi criado: houve injeção`);
  }
}

function vivo(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function esperarMorrer(pid) {
  for (let i = 0; i < 50 && vivo(pid); i++) await new Promise((r) => setTimeout(r, 100));
  return !vivo(pid);
}

const texto = (res) => res.content.map((c) => c.text).join("\n");
const chamar = async (name, args = {}) => texto(await client.callTool({ name, arguments: args }));

test("expõe as 16 ferramentas", async () => {
  const { tools } = await client.listTools();
  assert.equal(tools.length, 16);
});

test("ngrok_http: cada valor vira um único argumento literal", async () => {
  const res = await chamar("ngrok_http", { port: 3000, basicAuth: PAYLOAD, description: PAYLOAD, metadata: PAYLOAD, compression: true });
  const { argv } = ultimaChamada();
  assert.deepEqual(argv, [
    "ngrok",
    "http",
    "3000",
    `--basic-auth=${PAYLOAD}`,
    "--compression",
    `--metadata=${PAYLOAD}`,
    `--description=${PAYLOAD}`,
    ...FIM,
  ]);
  assert.match(res, /Túnel HTTP Criado[\s\S]*https:\/\/falso-\d+-0\.ngrok\.test/);
  nadaFoiExecutado();
  await chamar("ngrok_kill_all");
});

test("ngrok_tcp e ngrok_tls: payload não escapa do argumento", async () => {
  const tcp = await chamar("ngrok_tcp", { port: 22, name: PAYLOAD });
  assert.deepEqual(ultimaChamada().argv, ["ngrok", "tcp", "22", `--name=${PAYLOAD}`, ...FIM]);
  assert.match(tcp, /tcp:\/\/falso-/);

  await chamar("ngrok_tls", { port: 443, crt: PAYLOAD });
  assert.deepEqual(ultimaChamada().argv, ["ngrok", "tls", "443", `--crt=${PAYLOAD}`, ...FIM]);
  nadaFoiExecutado();
  await chamar("ngrok_kill_all");
});

test("ngrok_connect com https usa o comando http do ngrok v3", async () => {
  await chamar("ngrok_connect", { port: 8080, proto: "https" });
  assert.deepEqual(ultimaChamada().argv, ["ngrok", "http", "8080", ...FIM]);
  await chamar("ngrok_kill_all");
});

test("ngrok_diagnose: flags booleanas e valores", async () => {
  await chamar("ngrok_diagnose", { region: "sa", ipv6: true });
  assert.deepEqual(ultimaChamada().argv, ["ngrok", "diagnose", "--region=sa", "--ipv6"]);
});

test("túnel que falha ao abrir vira erro, não 'Túnel Criado'", async () => {
  const res = await chamar("ngrok_http", { port: 3000, name: "falhar" });
  assert.match(res, /Erro ao criar túnel HTTP[\s\S]*falha simulada/);
  assert.doesNotMatch(res, /Criado/);
  assert.match(await chamar("ngrok_list_tunnels"), /Nenhum túnel ativo/);
});

test("ciclo de vida: listar, inspecionar, logs e desconectar encerra o agente", async () => {
  const criado = await chamar("ngrok_http", { port: 3000 });
  const url = criado.match(/https:\/\/\S+/)[0];
  const id = criado.match(/ID: (\S+)/)[1];
  const { pid } = ultimaChamada();

  assert.ok((await chamar("ngrok_list_tunnels")).includes(url));

  await chamar("ngrok_inspect", { tunnelId: id });
  assert.equal(caminhosPedidos.at(-1), "/api/tunnels/command_line");

  const logs = await chamar("ngrok_logs", { url, limit: 5 });
  assert.match(logs, /GET \/ola → 200 \(12 ms\)/);
  assert.equal(caminhosPedidos.at(-1), "/api/requests/http?limit=5&tunnel_name=command_line");

  assert.match(await chamar("ngrok_disconnect", { url }), /Túnel Desconectado/);
  assert.ok(await esperarMorrer(pid), "o agente continuou rodando depois do disconnect");
  assert.match(await chamar("ngrok_list_tunnels"), /Nenhum túnel ativo/);
});

test("ngrok_start: nomes viram argumentos; nome começando com '-' é recusado", async () => {
  const res = await chamar("ngrok_start", { tunnels: "api web" });
  assert.deepEqual(ultimaChamada().argv, ["ngrok", "start", "api", "web", ...FIM]);
  assert.match(res, /Túneis Iniciados\*\* \(2\)/);
  await chamar("ngrok_kill_all");

  const antes = chamadas().length;
  const recusado = await chamar("ngrok_start", { tunnels: "--config=/etc/passwd" });
  assert.match(recusado, /não pode começar com "-"/);
  assert.equal(chamadas().length, antes);
});

test("ngrok_api: só caminhos da API local, sem executar nada", async () => {
  const antes = chamadas().length;
  assert.match(await chamar("ngrok_api", { endpoint: "tunnels list; touch pwned" }), /Endpoint inválido/);
  assert.match(await chamar("ngrok_api", { endpoint: "http://evil.example/api/x" }), /Endpoint inválido/);
  assert.match(await chamar("ngrok_api", { endpoint: "/api/../segredo" }), /Endpoint inválido/);
  assert.equal(chamadas().length, antes);
  nadaFoiExecutado();

  await chamar("ngrok_http", { port: 3000 });
  assert.match(await chamar("ngrok_api", { endpoint: "/api/tunnels" }), /API Response/);
  assert.equal(caminhosPedidos.at(-1), "/api/tunnels");
  await chamar("ngrok_kill_all");
});

test("authtoken do arquivo de configuração chega por variável de ambiente, não por argumento", async () => {
  await chamar("ngrok_status");
  const { argv, authtoken } = ultimaChamada();
  assert.equal(authtoken, AUTHTOKEN_FALSO);
  assert.ok(!argv.some((a) => a.includes(AUTHTOKEN_FALSO)));
});

test("ao encerrar a sessão MCP, nenhum agente fica rodando", async () => {
  const outro = await conectar();
  await outro.callTool({ name: "ngrok_http", arguments: { port: 3000 } });
  const { pid } = ultimaChamada();
  assert.ok(vivo(pid));
  await outro.close();
  assert.ok(await esperarMorrer(pid), "o agente ficou órfão depois que o servidor encerrou");
});
