// Substitui o ngrok nos testes (via NGROK_MCP_RUNNER). Acrescenta ao arquivo
// NGROK_FALSO_LOG uma linha JSON com o argv recebido e, quando chamado como agente
// (`--log-format=json`), imita o log do ngrok v3 e fica rodando até ser encerrado.
import fs from "node:fs";

const argv = process.argv.slice(2);
fs.appendFileSync(
  process.env.NGROK_FALSO_LOG,
  JSON.stringify({ argv, pid: process.pid, authtoken: process.env.NGROK_AUTHTOKEN ?? null }) + "\n",
);

if (!argv.includes("--log-format=json")) {
  process.stdout.write("ngrok version 3.0.0-falso\n");
  process.exit(0);
}

if (argv.includes("--name=falhar")) {
  process.stderr.write("ERROR:  falha simulada\n");
  process.exit(1);
}

const log = (obj) => process.stdout.write(JSON.stringify({ lvl: "info", t: new Date().toISOString(), ...obj }) + "\n");
log({ obj: "web", msg: "starting web service", addr: process.env.NGROK_FALSO_WEB });

const [comando, ...resto] = argv.slice(1);
const nomes = comando === "start" ? resto.filter((a) => !a.startsWith("-")) : ["command_line"];
const esquema = comando === "tcp" ? "tcp" : comando === "tls" ? "tls" : "https";
nomes.forEach((name, i) => {
  log({ obj: "tunnels", msg: "started tunnel", name, url: `${esquema}://falso-${process.pid}-${i}.ngrok.test` });
});

setInterval(() => {}, 60_000);
