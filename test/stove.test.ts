import { afterEach, describe, expect, it } from "vitest";
import { TransportError } from "../src/duepi";
import { nodeConnector } from "../src/nodeTransport";
import { readStatus, resetAlarm, setPower, setSetpoint, turnOff, turnOn } from "../src/stove";
import { startFakeRelay, type FakeRelay } from "./fakeRelay";

const CODE = "ABCD1234";
let relay: FakeRelay | undefined;
afterEach(async () => {
  await relay?.close();
  relay = undefined;
});

const v = (hex4: string, tail = "00") => hex4 + tail;
const off = { RD9000: v("0000"), RD3000: v("0003"), RD4000: v("0000"), RD1000: v("00C3"), RD0000: v("0019"), RDA000: v("0000") };
const heating = { ...off, RD9000: v("0201"), RD4000: v("0003") };
const writes = () => relay!.received.filter((c) => c.startsWith("RF"));

async function opts(registers: Record<string, string>) {
  relay = await startFakeRelay(CODE, registers);
  return { connect: nodeConnector("127.0.0.1", relay.port), deviceCode: CODE, loginDelayMs: 20 };
}

describe("poêle via le relais", () => {
  it("se connecte comme master et lit toutes les données", async () => {
    const o = await opts({ ...off, RDF000: v("0020"), REF000: v("0096"), RC0000: v("0100"), RED000: "000ABC", REE000: "000012" });
    const s = await readStatus(o);
    expect(relay!.logins).toEqual([`master:${CODE}`]);
    expect(s).toMatchObject({
      etat: "eteint",
      roomTemperature: 19.5,
      fumesTemperature: 25,
      powerSetting: 3,
      errorCode: 0,
      extras: { pcbTemp: 32, fanRpm: 1500, pressureOk: true, hoursTotal: 0xabc, hoursPartial: 0x12 },
      unsupported: [],
    });
  });

  it("pressostat : OK, défaut, ou rien si la valeur ne veut rien dire (0 sur le poêle de Kevin)", async () => {
    const regs = { ...heating, RDF000: v("0020"), REF000: v("0096"), RED000: "000ABC", REE000: "000012" };
    const o = await opts({ ...regs, RC0000: v("0300") });
    expect((await readStatus(o)).extras.pressureOk).toBe(false);
    relay!.registers.RC0000 = v("0000");
    const s = await readStatus(o);
    expect(s.extras).toEqual({ pcbTemp: 32, fanRpm: 1500, hoursTotal: 0xabc, hoursPartial: 0x12 });
    expect(s.unsupported).toEqual([]);
  });

  it("masque une donnée à laquelle le poêle ne répond pas", async () => {
    const o = await opts({ ...off, RDF000: v("0020") });
    const s = await readStatus(o);
    expect(s.extras).toEqual({ pcbTemp: 32 });
    expect(s.unsupported).toEqual(["fanRpm"]); // on s'arrête au premier silence
  }, 15000);

  it("ne relit pas les données déjà connues comme absentes", async () => {
    const o = await opts(off);
    const s = await readStatus(o, ["pcbTemp", "fanRpm", "pressureOk", "hoursTotal", "hoursPartial"]);
    expect(s.unsupported).toEqual([]);
    expect(relay!.received).toEqual(["RD9000", "RD3000", "RD4000", "RD1000", "RD0000", "RDA000"]);
  });

  it("allume un poêle éteint avec la puissance choisie", async () => {
    const o = await opts(off);
    expect(await turnOn(o, 4)).toEqual({ result: "allumage" });
    expect(writes()).toEqual(["RF0040"]);
  });

  it("refuse d'allumer un poêle en erreur", async () => {
    const o = await opts({ ...off, RDA000: v("0005") });
    expect(await turnOn(o, 3)).toMatchObject({ result: "refuse" });
    expect(writes()).toEqual([]);
  });

  it("n'envoie rien pendant l'allumage", async () => {
    const o = await opts({ ...off, RD9000: v("0102") });
    expect(await turnOn(o, 3)).toEqual({ result: "deja-en-allumage" });
    expect(writes()).toEqual([]);
  });

  it("n'envoie puissance et consigne qu'en chauffe", async () => {
    let o = await opts(off);
    expect(await setPower(o, 2)).toBe(false);
    expect(await setSetpoint(o, 22)).toBe(false);
    expect(writes()).toEqual([]);
    await relay!.close();
    o = await opts(heating);
    expect(await setPower(o, 2)).toBe(true);
    expect(await setSetpoint(o, 22)).toBe(true);
    expect(writes()).toEqual(["RF0020", "RF2160"]);
  });

  it("éteint et réinitialise l'alarme", async () => {
    const o = await opts(off);
    await turnOff(o);
    await resetAlarm(o);
    expect(relay!.received).toEqual(["RF0000", "RD6000"]);
  });

  it("signale un poêle injoignable", async () => {
    await expect(turnOff({ connect: nodeConnector("127.0.0.1", 1), deviceCode: CODE })).rejects.toBeInstanceOf(TransportError);
  });
});
