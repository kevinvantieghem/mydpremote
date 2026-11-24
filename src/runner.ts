// Ce que le serveur fait à chaque passage (GitHub Actions, toutes les 5 minutes environ) :
// les plages, la consigne en attente après un allumage par plage, et le mode Auto.
// Fonction pure côté données : elle reçoit l'état, le renvoie modifié, le script l'enregistre.

import { MAX_POWER, MAX_TEMPERATURE, MIN_POWER, MIN_TEMPERATURE, type RelayOptions } from "./duepi";
import { dueActions, finalAction, insideOtherPlage, parisTime, pruneFired, type Plage } from "./scheduler";
import { applyAuto, setSetpoint, turnOff, turnOn } from "./stove";

/** GitHub lance souvent le passage en retard : on rattrape jusqu'à 45 minutes. */
export const CATCH_UP_MINUTES = 45;
/** Puissance d'allumage par plage en mode Auto ; elle est ajustée dès que le poêle chauffe. */
export const AUTO_IGNITION_POWER = 3;
const IGNITION_COOLDOWN_MS = 60_000;
const OFF_LATCH_MS = 10 * 60_000;
const PENDING_SETPOINT_MS = 60 * 60_000;

/** Choix faits dans l'app (écrits par le téléphone). */
export interface Prefs {
  power: number;
  setpoint: number;
  auto: boolean;
}

/** Mémoire du serveur (écrite par le serveur seulement). */
export interface Etat {
  /** Actions de plage déjà faites (clé -> date ISO). */
  fired: Record<string, string>;
  lastIgnition?: string;
  offAt?: string;
  pendingSetpoint: boolean;
  pendingSince?: string;
  /** Extinction de plage qui a échoué : plage concernée. On réessaie jusqu'à réussir. */
  pendingOff?: string;
  /** Date du dernier passage (AAAA-MM-JJ) : change une fois par jour, garde le dépôt actif. */
  vivant?: string;
}

/** "error" : une action de plage a échoué. "warning" : poêle injoignable, sans action de plage en jeu. */
export type Log = (line: string, level?: "error" | "warning") => void;

export const DEFAULT_PREFS: Prefs = { power: 3, setpoint: 21, auto: false };
export const DEFAULT_ETAT: Etat = { fired: {}, pendingSetpoint: false };

const clampInt = (v: unknown, min: number, max: number, fallback: number) => {
  const n = Number(v);
  return Number.isInteger(n) && n >= min && n <= max ? n : fallback;
};

export function cleanPrefs(input: unknown): Prefs {
  const p = (input ?? {}) as Record<string, unknown>;
  return {
    power: clampInt(p.power, MIN_POWER, MAX_POWER, DEFAULT_PREFS.power),
    setpoint: clampInt(p.setpoint, MIN_TEMPERATURE, MAX_TEMPERATURE, DEFAULT_PREFS.setpoint),
    auto: p.auto === true,
  };
}

const within = (iso: string | undefined, ms: number, now: Date) =>
  iso !== undefined && now.getTime() - Date.parse(iso) < ms;

export async function tick(
  plages: Plage[],
  prefs: Prefs,
  before: Etat,
  relay: RelayOptions,
  now = new Date(),
  log: Log = (line) => console.log(line),
): Promise<Etat> {
  let etat: Etat = { ...before, fired: { ...before.fired }, vivant: parisTime(now).date };
  const stamp = now.toISOString();

  // 1. Plages
  const due = dueActions(plages, now, etat.fired, CATCH_UP_MINUTES);
  const action = finalAction(due);
  if (action) {
    if (action.action === "on") etat.pendingOff = undefined; // un allumage plus récent annule l'extinction en attente
    let done = true;
    try {
      if (action.action === "on") {
        if (within(etat.lastIgnition, IGNITION_COOLDOWN_MS, now)) {
          log(`Plage ${action.plageId} : allumage ignoré (déjà demandé il y a moins d'une minute)`);
        } else {
          const power = prefs.auto ? AUTO_IGNITION_POWER : prefs.power;
          const result = await turnOn(relay, power);
          log(`Plage ${action.plageId} : allumer → ${result.result}${"reason" in result ? ` (${result.reason})` : ""}`);
          if (result.result !== "refuse") {
            etat = {
              ...etat,
              offAt: undefined,
              lastIgnition: result.result === "allumage" ? stamp : etat.lastIgnition,
              pendingSetpoint: true,
              pendingSince: stamp,
            };
          }
        }
      } else if (insideOtherPlage(plages, now, action.plageId)) {
        log(`Plage ${action.plageId} : fin ignorée, une autre plage est en cours`);
        etat.pendingOff = undefined;
      } else {
        await turnOff(relay);
        log(`Plage ${action.plageId} : éteindre → envoyé`);
        etat = { ...etat, pendingSetpoint: false, pendingOff: undefined, offAt: stamp };
      }
    } catch (err) {
      // Poêle injoignable : on réessaie au passage suivant, dans la fenêtre de rattrapage.
      done = false;
      log(`Plage ${action.plageId} : ${action.action} a échoué : ${(err as Error).message}`, "error");
      if (action.action === "off") return { ...etat, pendingSetpoint: false, pendingOff: action.plageId };
    }
    if (done) {
      for (const a of due) etat.fired[a.key] = stamp;
      etat.fired = pruneFired(etat.fired, now);
      return etat; // le reste attendra le passage suivant
    }
  }

  // Extinction qui a échoué et dont la fenêtre de rattrapage est passée
  if (!action && etat.pendingOff !== undefined) {
    if (insideOtherPlage(plages, now, "")) {
      etat = { ...etat, pendingOff: undefined };
    } else {
      try {
        await turnOff(relay);
        log(`Plage ${etat.pendingOff} : éteindre (en attente) → envoyé`);
        return { ...etat, pendingOff: undefined, offAt: stamp };
      } catch (err) {
        log(`Plage ${etat.pendingOff} : éteindre (en attente) a échoué : ${(err as Error).message}`, "error");
        return etat;
      }
    }
  }

  // 2. Consigne en attente (après un allumage par plage)
  if (etat.pendingSetpoint) {
    if (!within(etat.pendingSince, PENDING_SETPOINT_MS, now)) {
      etat = { ...etat, pendingSetpoint: false };
    } else {
      try {
        if (await setSetpoint(relay, prefs.setpoint)) {
          log(`Consigne ${prefs.setpoint} °C envoyée`);
          etat = { ...etat, pendingSetpoint: false };
        }
      } catch (err) {
        log(`Consigne en attente : ${(err as Error).message}`, "warning");
      }
    }
  }

  // 3. Mode Auto
  if (prefs.auto && !within(etat.offAt, OFF_LATCH_MS, now)) {
    try {
      const r = await applyAuto(relay, prefs.setpoint);
      if (!r.heating) log("Auto : le poêle ne chauffe pas, rien à faire");
      else if (r.sent) log(`Auto : pièce ${r.room} °C pour ${prefs.setpoint} °C → puissance ${r.power} envoyée`);
      else log(`Auto : pièce ${r.room} °C pour ${prefs.setpoint} °C, puissance ${r.power} déjà en place`);
    } catch (err) {
      log(`Auto : ${(err as Error).message}`, "warning");
    }
  }

  return etat;
}
