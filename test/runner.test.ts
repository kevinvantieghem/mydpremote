import { afterEach, describe, expect, it } from "vitest";
import { nodeConnector } from "../src/nodeTransport";
import { DEFAULT_ETAT, cleanPrefs, tick, type Etat, type Prefs } from "../src/runner";
import type { Plage } from "../src/scheduler";
import { autoPower } from "../src/stove";
import { startFakeRelay, type FakeRelay } from "./fakeRelay";

const CODE = "ABCD1234";
let relay: FakeRelay | undefined;
afterEach(async () => {
  await relay?.close();
  relay = undefined;
});

const v = (hex4: string) => `${hex4}00`;
const temp = (c: number) => v(Math.round(c * 10).toString(16).padStart(4, "0"));
const off = { RD9000: v("0000"), RD3000: v("0003"), RD4000: v("0000"), RD1000: temp(19.5), RD0000: v("0019"), RDA000: v("0000") };
const heating = { ...off, RD9000: v("0201"), RD4000: v("0003") };
const writes = () => relay!.received.filter((c) => c.startsWith("RF"));

async function opts(registers: Record<string, string>) {
  relay = await startFakeRelay(CODE, registers);
  return { connect: nodeConnector("127.0.0.1", relay.port), deviceCode: CODE, loginDelayMs: 20 };
}

// 2026-11-23 est un lundi ; Paris = UTC+1 en hiver.
const paris = (iso: string) => new Date(`${iso}+01:00`);
const matin: Plage = { id: "matin", nom: "Matin", debut: "07:00", fin: "08:00", jours: Array(7).fill(true), actif: true };
const manuel: Prefs = { power: 4, setpoint: 21, auto: false };
const auto: Prefs = { power: 4, setpoint: 21, auto: true };
const silent = () => undefined;

describe("mode Auto : puissance selon l'écart à la consigne", () => {
  it("donne 5 quand la pièce est froide et 1 une fois la consigne atteinte", () => {
    expect(autoPower(21, 18)).toBe(5);
    expect(autoPower(21, 19)).toBe(5);
    expect(autoPower(21, 19.5)).toBe(4);
    expect(autoPower(21, 20)).toBe(3);
    expect(autoPower(21, 20.5)).toBe(2);
    expect(autoPower(21, 20.6)).toBe(1);
    expect(autoPower(21, 22)).toBe(1);
  });
});

describe("passage du serveur", () => {
  it("allume une plage même lancée 20 minutes en retard, une seule fois", async () => {
    const o = await opts(off);
    const etat = await tick([matin], manuel, DEFAULT_ETAT, o, paris("2026-11-23T07:20:00"), silent);
    expect(writes()).toEqual(["RF0040"]);
    expect(etat.pendingSetpoint).toBe(true);
    expect(Object.keys(etat.fired)).toEqual(["matin:on:2026-11-23"]);
    await tick([matin], manuel, etat, o, paris("2026-11-23T07:25:00"), silent);
    expect(writes()).toEqual(["RF0040"]); // pas de second allumage (le poêle ne chauffe pas encore)
  });

  it("ne rattrape pas une plage plus vieille que 45 minutes", async () => {
    const o = await opts(off);
    await tick([matin], manuel, DEFAULT_ETAT, o, paris("2026-11-23T07:46:00"), silent);
    expect(writes()).toEqual([]);
  });

  it("en Auto, allume à la puissance 3", async () => {
    const o = await opts(off);
    await tick([matin], auto, DEFAULT_ETAT, o, paris("2026-11-23T07:02:00"), silent);
    expect(writes()).toEqual(["RF0030"]);
  });

  it("en Auto, monte puis baisse la puissance selon la pièce, sans renvoyer la même", async () => {
    const o = await opts({ ...heating, RD1000: temp(18) });
    const now = paris("2026-11-23T12:00:00");
    await tick([], auto, DEFAULT_ETAT, o, now, silent);
    expect(writes()).toEqual(["RF0050"]);

    relay!.registers.RD3000 = v("0005");
    await tick([], auto, DEFAULT_ETAT, o, now, silent);
    expect(writes()).toEqual(["RF0050"]); // déjà à 5 : rien

    relay!.registers.RD1000 = temp(21.2);
    await tick([], auto, DEFAULT_ETAT, o, now, silent);
    expect(writes()).toEqual(["RF0050", "RF0010"]);
  });

  it("en Auto, n'envoie rien si le poêle ne chauffe pas, ni juste après une extinction", async () => {
    const o = await opts({ ...off, RD1000: temp(15) });
    await tick([], auto, DEFAULT_ETAT, o, paris("2026-11-23T12:00:00"), silent);
    expect(writes()).toEqual([]);

    relay!.registers = { ...heating, RD1000: temp(15) };
    const justOff: Etat = { ...DEFAULT_ETAT, offAt: paris("2026-11-23T11:55:00").toISOString() };
    await tick([], auto, justOff, o, paris("2026-11-23T12:00:00"), silent);
    expect(writes()).toEqual([]);
  });

  it("hors Auto et sans plage due, ne contacte pas le poêle", async () => {
    const o = await opts(heating);
    await tick([matin], manuel, DEFAULT_ETAT, o, paris("2026-11-23T12:00:00"), silent);
    expect(relay!.logins).toEqual([]);
  });

  it("envoie la consigne en attente quand le poêle chauffe", async () => {
    const o = await opts(heating);
    const now = paris("2026-11-23T07:30:00");
    const before: Etat = { ...DEFAULT_ETAT, pendingSetpoint: true, pendingSince: paris("2026-11-23T07:00:00").toISOString() };
    const etat = await tick([], manuel, before, o, now, silent);
    expect(writes()).toEqual(["RF2150"]);
    expect(etat.pendingSetpoint).toBe(false);
  });

  it("nettoie des préférences abîmées", () => {
    expect(cleanPrefs({ power: 9, setpoint: "x", auto: "oui" })).toEqual({ power: 3, setpoint: 21, auto: false });
    expect(cleanPrefs(undefined)).toEqual({ power: 3, setpoint: 21, auto: false });
  });
});

describe("extinction qui échoue", () => {
  const panne = { connect: nodeConnector("127.0.0.1", 1), deviceCode: CODE, loginDelayMs: 20 };

  it("réessaie bien après 45 minutes, jusqu'à réussir, une seule fois", async () => {
    const niveaux: (string | undefined)[] = [];
    const log = (_: string, n?: string) => void niveaux.push(n);
    let etat = await tick([matin], auto, DEFAULT_ETAT, panne, paris("2026-11-23T08:02:00"), log);
    expect(etat.pendingOff).toBe("matin");
    etat = await tick([matin], auto, etat, panne, paris("2026-11-23T11:00:00"), log);
    expect(etat.pendingOff).toBe("matin");
    expect(niveaux).toEqual(["error", "error"]);

    const o = await opts(heating);
    etat = await tick([matin], auto, etat, o, paris("2026-11-23T14:00:00"), silent);
    expect(writes()).toEqual(["RF0000"]);
    expect(etat.pendingOff).toBeUndefined();
    await tick([matin], manuel, etat, o, paris("2026-11-23T14:05:00"), silent);
    expect(writes()).toEqual(["RF0000"]);
  });

  it("dans les 45 minutes, une extinction réussie efface l'attente", async () => {
    const attente = await tick([matin], manuel, DEFAULT_ETAT, panne, paris("2026-11-23T08:02:00"), silent);
    const o = await opts(heating);
    const etat = await tick([matin], manuel, attente, o, paris("2026-11-23T08:07:00"), silent);
    expect(etat.pendingOff).toBeUndefined();
    await tick([matin], manuel, etat, o, paris("2026-11-23T10:00:00"), silent);
    expect(writes()).toEqual(["RF0000"]);
  });

  it("abandonne l'extinction si une plage a repris", async () => {
    const o = await opts(off);
    const etat = await tick([matin], manuel, { ...DEFAULT_ETAT, pendingOff: "soir" }, o, paris("2026-11-23T07:01:00"), silent);
    expect(writes()).toEqual(["RF0040"]);
    expect(etat.pendingOff).toBeUndefined();
  });

  it("un Auto injoignable est un avertissement, pas une erreur", async () => {
    const niveaux: (string | undefined)[] = [];
    await tick([], auto, DEFAULT_ETAT, panne, paris("2026-11-23T12:00:00"), (_, n) => void niveaux.push(n));
    expect(niveaux).toEqual(["warning"]);
  });
});
