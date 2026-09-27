// Teste manual contra o ngrok real (npm run test:real): sobe um servidor HTTP local,
// abre um túnel com basic auth pelo MCP, acessa a URL pública, confere os logs e
// fecha tudo. Requer o ngrok e um authtoken configurados.
import http from "node:http";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const raiz = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORTA = 3999;
const TIMEOUT = 45_000;
const CREDENCIAIS = `teste:${randomBytes(12).toString("hex")}`;
const CORPO = "ola do teste real";

const local = http.createServer((_req, res) => res.end(CORPO));
await new Promise((r) => local.listen(PORTA, "127.0.0.1", r));

const client = new Client({ name: "teste-real", version: "1.0.0" });
await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(raiz, "dist", "index.js")] }));

async function chamar(name, args = {}) {
  const inicio = Date.now();
  try {
    const res = await client.callTool({ name, arguments: args }, undefined, { timeout: TIMEOUT });
    const texto = res.content.map((c) => c.text).join("\n");
    console.log(`\n=== ${name} (${Date.now() - inicio} ms)\n${texto}`);
    return texto;
  } catch (e) {
    console.log(`\n=== ${name} FALHOU (${Date.now() - inicio} ms): ${e.message}`);
    return "";
  }
}

let falhas = 0;
const verificar = (ok, msg) => {
  console.log(`${ok ? "✔" : "✖"} ${msg}`);
  if (!ok) falhas++;
};
const semAviso = { "ngrok-skip-browser-warning": "1" };

try {
  verificar(/ngrok version 3\./.test(await chamar("ngrok_status")), "ngrok_status mostra a versão do agente");
  verificar((await chamar("ngrok_config_check")).includes("Configuração Válida"), "ngrok_config_check valida a configuração");

  const criado = await chamar("ngrok_http", { port: PORTA, basicAuth: CREDENCIAIS });
  const url = criado.match(/https:\/\/\S+/)?.[0];
  verificar(!!url, "ngrok_http devolve a URL pública");

  if (url) {
    const semAuth = await fetch(url, { headers: semAviso });
    verificar(semAuth.status === 401, `sem credenciais a URL responde 401 (veio ${semAuth.status})`);

    const comAuth = await fetch(url, {
      headers: { ...semAviso, authorization: "Basic " + Buffer.from(CREDENCIAIS).toString("base64") },
    });
    const corpo = await comAuth.text();
    verificar(comAuth.status === 200 && corpo === CORPO, `com credenciais chega ao servidor local (${comAuth.status})`);

    verificar((await chamar("ngrok_list_tunnels")).includes(url), "ngrok_list_tunnels mostra o túnel");
    verificar((await chamar("ngrok_inspect", { url })).includes('"public_url"'), "ngrok_inspect traz os detalhes do agente");
    verificar(/GET \/ → 200/.test(await chamar("ngrok_logs", { url, limit: 5 })), "ngrok_logs mostra a requisição autenticada");
    verificar((await chamar("ngrok_api", { endpoint: "/api/tunnels" })).includes(url), "ngrok_api consulta a API local do agente");

    verificar((await chamar("ngrok_disconnect", { url })).includes("Desconectado"), "ngrok_disconnect encerra o túnel");
    await new Promise((r) => setTimeout(r, 3000));
    const depois = await fetch(url, { headers: semAviso }).catch(() => null);
    verificar(!depois || depois.status === 404, `depois do disconnect a URL não chega mais ao servidor (${depois?.status ?? "sem conexão"})`);
    verificar((await chamar("ngrok_list_tunnels")).includes("Nenhum túnel ativo"), "a lista fica vazia");
  }
} finally {
  await chamar("ngrok_kill_all");
  await client.close();
  local.close();
  console.log(falhas ? `\n${falhas} verificação(ões) falharam` : "\nTudo OK");
  process.exit(falhas ? 1 : 0);
}
