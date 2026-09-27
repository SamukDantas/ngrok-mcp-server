// Garante que valores vindos do modelo chegam ao ngrok como argumentos literais,
// sem passar por shell. O servidor roda de verdade (dist/index.js, via stdio),
// mas o `npx ngrok` é trocado por um script que só registra o argv.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
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

// Interpolado como `--basic-auth="${valor}"` (o código antigo), fecha as aspas e
// cria pwned.txt tanto em sh quanto em cmd; os demais cobrem $() e crases no sh.
const PAYLOAD = `a:b" & echo pwned > pwned.txt & echo "; touch pwned; $(touch pwned2) \`touch pwned3\``;

let client;

before(async () => {
  fs.mkdirSync(path.join(home, ".config", "opencode"), { recursive: true });
  fs.writeFileSync(
    path.join(home, ".config", "opencode", "ngrok-config.json"),
    JSON.stringify({ authtoken: AUTHTOKEN_FALSO }),
  );
  client = new Client({ name: "teste", version: "1.0.0" });
  await client.connect(
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
      },
    }),
  );
});

after(async () => {
  await client?.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

function chamadas() {
  if (!fs.existsSync(log)) return [];
  return fs.readFileSync(log, "utf-8").trim().split("\n").map((l) => JSON.parse(l));
}

function ultimaChamada() {
  const todas = chamadas();
  assert.ok(todas.length > 0, "o runner falso não foi chamado");
  return todas.at(-1);
}

function nadaFoiExecutado() {
  for (const f of ["pwned", "pwned.txt", "pwned2", "pwned3"]) {
    assert.equal(fs.existsSync(path.join(tmp, f)), false, `${f} foi criado: houve injeção`);
  }
}

test("expõe as 16 ferramentas", async () => {
  const { tools } = await client.listTools();
  assert.equal(tools.length, 16);
});

test("ngrok_http: cada valor vira um único argumento literal", async () => {
  await client.callTool({
    name: "ngrok_http",
    arguments: { port: 3000, basicAuth: PAYLOAD, description: PAYLOAD, metadata: PAYLOAD, compression: true },
  });
  const { argv } = ultimaChamada();
  assert.deepEqual(argv, [
    "ngrok",
    "http",
    "3000",
    `--basic-auth=${PAYLOAD}`,
    "--compression",
    `--metadata=${PAYLOAD}`,
    `--description=${PAYLOAD}`,
  ]);
  nadaFoiExecutado();
});

test("ngrok_tcp e ngrok_tls: payload não escapa do argumento", async () => {
  await client.callTool({ name: "ngrok_tcp", arguments: { port: 22, name: PAYLOAD } });
  assert.deepEqual(ultimaChamada().argv, ["ngrok", "tcp", "22", `--name=${PAYLOAD}`]);

  await client.callTool({ name: "ngrok_tls", arguments: { port: 443, crt: PAYLOAD } });
  assert.deepEqual(ultimaChamada().argv, ["ngrok", "tls", "443", `--crt=${PAYLOAD}`]);
  nadaFoiExecutado();
});

test("ngrok_diagnose: flags booleanas e valores", async () => {
  await client.callTool({ name: "ngrok_diagnose", arguments: { region: "sa", ipv6: true } });
  assert.deepEqual(ultimaChamada().argv, ["ngrok", "diagnose", "--region=sa", "--ipv6"]);
});

test("ID de túnel começando com '-' é recusado, sem chamar o ngrok", async () => {
  const antes = chamadas().length;
  const res = await client.callTool({ name: "ngrok_inspect", arguments: { tunnelId: "--config=/etc/passwd" } });
  assert.match(res.content[0].text, /não pode começar com "-"/);
  assert.equal(chamadas().length, antes);
});

test("ngrok_api: endpoint com metacaracteres não executa nada", async () => {
  await client.callTool({ name: "ngrok_api", arguments: { endpoint: "tunnels list; touch pwned" } });
  assert.deepEqual(ultimaChamada().argv, ["ngrok", "api", "tunnels", "list;", "touch", "pwned"]);
  nadaFoiExecutado();
});

test("authtoken do arquivo de configuração chega por variável de ambiente, não por argumento", async () => {
  await client.callTool({ name: "ngrok_status", arguments: {} });
  const { argv, authtoken } = ultimaChamada();
  assert.equal(authtoken, AUTHTOKEN_FALSO);
  assert.ok(!argv.some((a) => a.includes(AUTHTOKEN_FALSO)));
});
