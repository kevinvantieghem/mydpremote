// Lecture SEULE du poêle (aucune commande envoyée). Sert à vérifier chaque donnée.
// Usage : DP_CODE=... DP_HOST=duepiwebserver4.com DP_PORT=3000 npm run probe
import { value4, value6, withSession } from "../src/duepi";
import { nodeConnector } from "../src/nodeTransport";
import { errorLabel, phaseEtat, pressureOk } from "../src/stove";

const code = process.env.DP_CODE;
const host = process.env.DP_HOST;
const port = Number(process.env.DP_PORT ?? 3000);
if (!code || !host) {
  console.error("Il manque DP_CODE ou DP_HOST.");
  process.exit(1);
}

const registers: [string, string, (d: string) => string][] = [
  ["RD9000", "Phase", (d) => `${phaseEtat(value4(d)).label} (0x${d.slice(0, 4)})`],
  ["RD3000", "Puissance réglée", (d) => String(value4(d))],
  ["RD4000", "Puissance réelle", (d) => String(value4(d))],
  ["RD1000", "Température pièce", (d) => `${value4(d) / 10} °C`],
  ["RD0000", "Température fumées", (d) => `${value4(d)} °C`],
  ["RDA000", "Erreur", (d) => `${value4(d)} : ${errorLabel(value4(d))}`],
  ["RDF000", "Température carte", (d) => `${value4(d)} °C`],
  ["REF000", "Ventilateur fumées", (d) => `${value4(d) * 10} tr/min`],
  ["RC0000", "Pressostat", (d) => ({ true: "OK", false: "Défaut" }[String(pressureOk(value4(d)))] ?? `sans information (0x${d.slice(0, 4)})`)],
  ["RED000", "Heures totales", (d) => String(value6(d))],
  ["REE000", "Heures partielles", (d) => String(value6(d))],
];

// Une connexion par registre : un registre muet ne fausse pas les suivants.
for (const [register, label, show] of registers) {
  try {
    const data = await withSession({ connect: nodeConnector(host, port), deviceCode: code }, (s) => s.read(register));
    console.log(`${register}  ${label.padEnd(20)} ${show(data).padEnd(28)} brut=${data}`);
  } catch (err) {
    console.log(`${register}  ${label.padEnd(20)} ✗ ${(err as Error).message}`);
  }
}
