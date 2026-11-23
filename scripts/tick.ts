// Lancé par GitHub Actions (.github/workflows/poele.yml) toutes les 5 minutes environ.
// Lit donnees/plages.json et donnees/prefs.json (écrits par le téléphone),
// agit sur le poêle, puis réécrit donnees/etat.json seulement s'il a changé.
// Option --status : lit l'état du poêle et l'affiche, sans rien envoyer ni écrire.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { nodeConnector } from "../src/nodeTransport";
import { DEFAULT_ETAT, cleanPrefs, tick, type Etat } from "../src/runner";
import { validatePlages } from "../src/scheduler";
import { readStatus } from "../src/stove";

const DIR = new URL("../donnees/", import.meta.url);
const read = (name: string): unknown => {
  const file = new URL(name, DIR);
  return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : undefined;
};

const { DEVICE_CODE, RELAY_HOST, RELAY_PORT } = process.env;
if (!DEVICE_CODE || !RELAY_HOST) {
  console.error("Il manque les secrets DEVICE_CODE ou RELAY_HOST.");
  process.exit(1);
}
const relay = { connect: nodeConnector(RELAY_HOST, Number(RELAY_PORT || 3000)), deviceCode: DEVICE_CODE };

if (process.argv.includes("--status")) {
  const s = await readStatus(relay);
  console.log(`État : ${s.etatLabel}, pièce ${s.roomTemperature} °C, puissance ${s.powerSetting}, erreur : ${s.errorLabel}`);
  process.exit(0);
}

const plages = validatePlages(read("plages.json") ?? []);
const prefs = cleanPrefs(read("prefs.json"));
const before: Etat = { ...DEFAULT_ETAT, ...(read("etat.json") as Partial<Etat> | undefined) };

const after = await tick(plages, prefs, before, relay);

const text = `${JSON.stringify(after, null, 2)}\n`;
if (text !== `${JSON.stringify(before, null, 2)}\n`) {
  writeFileSync(new URL("etat.json", DIR), text);
  console.log("État enregistré.");
}
