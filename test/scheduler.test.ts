import { describe, expect, it } from "vitest";
import { dueActions, finalAction, insideOtherPlage, parisTime, validatePlages, type Plage } from "../src/scheduler";

const tous = Array(7).fill(true);
const plage = (o: Partial<Plage>): Plage => ({ id: "p", nom: "P", debut: "06:30", fin: "08:30", jours: tous, actif: true, ...o });
// 2026-11-23 est un lundi ; Paris = UTC+1 en hiver.
const paris = (iso: string) => new Date(`${iso}+01:00`);

describe("heure de Paris", () => {
  it("donne le jour et la minute", () => {
    expect(parisTime(paris("2026-11-23T06:30:00"))).toEqual({ day: 0, minutes: 390, date: "2026-11-23" });
    expect(parisTime(new Date("2026-07-05T05:00:00Z"))).toMatchObject({ day: 6, minutes: 420 }); // été : UTC+2
  });
});

describe("plages", () => {
  it("allume au début et éteint à la fin", () => {
    const p = [plage({})];
    expect(dueActions(p, paris("2026-11-23T06:30:20"), {}).map((a) => a.action)).toEqual(["on"]);
    expect(dueActions(p, paris("2026-11-23T08:30:05"), {}).map((a) => a.action)).toEqual(["off"]);
    expect(dueActions(p, paris("2026-11-23T07:00:00"), {})).toEqual([]);
  });

  it("ne se déclenche qu'une fois", () => {
    const p = [plage({})];
    const [a] = dueActions(p, paris("2026-11-23T06:30:00"), {});
    expect(dueActions(p, paris("2026-11-23T06:31:00"), { [a!.key]: "x" })).toEqual([]);
  });

  it("rattrape une minute manquée, mais pas au-delà de 5 minutes", () => {
    const p = [plage({})];
    expect(dueActions(p, paris("2026-11-23T06:34:00"), {})).toHaveLength(1);
    expect(dueActions(p, paris("2026-11-23T06:35:00"), {})).toHaveLength(0);
  });

  it("respecte les jours cochés et l'interrupteur", () => {
    const lundiSeul = [true, false, false, false, false, false, false];
    expect(dueActions([plage({ jours: lundiSeul })], paris("2026-11-24T06:30:00"), {})).toEqual([]);
    expect(dueActions([plage({ jours: lundiSeul })], paris("2026-11-23T06:30:00"), {})).toHaveLength(1);
    expect(dueActions([plage({ actif: false })], paris("2026-11-23T06:30:00"), {})).toEqual([]);
  });

  it("gère une plage qui passe minuit (fin le lendemain d'un jour coché)", () => {
    const dimanche = [false, false, false, false, false, false, true];
    const p = [plage({ debut: "22:00", fin: "01:00", jours: dimanche })];
    expect(dueActions(p, paris("2026-11-22T22:00:00"), {}).map((a) => a.action)).toEqual(["on"]);
    expect(dueActions(p, paris("2026-11-23T01:00:00"), {}).map((a) => a.action)).toEqual(["off"]);
    expect(dueActions(p, paris("2026-11-24T01:00:00"), {})).toEqual([]);
  });

  it("garde la dernière action, « allumer » gagne à égalité", () => {
    const p = [plage({ id: "a", debut: "06:00", fin: "08:30" }), plage({ id: "b", debut: "08:30", fin: "10:00" })];
    expect(finalAction(dueActions(p, paris("2026-11-23T08:30:00"), {}))?.action).toBe("on");
  });

  it("n'éteint pas au milieu d'une autre plage", () => {
    const p = [plage({ id: "a", debut: "06:00", fin: "09:00" }), plage({ id: "b", debut: "07:00", fin: "08:00" })];
    expect(insideOtherPlage(p, paris("2026-11-23T08:00:00"), "b")).toBe(true);
    expect(insideOtherPlage(p, paris("2026-11-23T09:00:00"), "a")).toBe(false);
  });

  it("valide ce que l'app envoie", () => {
    expect(validatePlages([plage({})])).toHaveLength(1);
    expect(() => validatePlages([plage({ debut: "25:00" })])).toThrow(RangeError);
    expect(() => validatePlages([plage({ fin: "06:30" })])).toThrow(RangeError);
    expect(() => validatePlages([plage({}), plage({})])).toThrow(RangeError);
  });
});
