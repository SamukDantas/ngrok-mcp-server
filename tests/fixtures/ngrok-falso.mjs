// Substitui o `npx` nos testes (via NGROK_MCP_RUNNER): em vez de executar o ngrok,
// acrescenta ao arquivo NGROK_FALSO_LOG uma linha JSON com o argv recebido.
import fs from "node:fs";

fs.appendFileSync(
  process.env.NGROK_FALSO_LOG,
  JSON.stringify({ argv: process.argv.slice(2), authtoken: process.env.NGROK_AUTHTOKEN ?? null }) + "\n",
);
process.stdout.write("ngrok falso ok\n");
