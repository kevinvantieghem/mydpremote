// Ce que l'app sait faire avec le poêle, au-dessus du protocole. Portage de src/stove.ts.
//
// Règles de sécurité (une commande de puissance sur un poêle éteint l'allume) :
// - seul turnOn() envoie une puissance à un poêle éteint, et seulement s'il est
//   vraiment éteint et sans erreur ;
// - puissance et consigne ne sont envoyées qu'en chauffe stable (phase 0x0201) ;
// - la consigne ne se relit pas : on garde la dernière envoyée dans l'app.

package app.mydpremote

import org.json.JSONArray
import org.json.JSONObject
import java.time.Instant

object Stove {
    const val PHASE_OFF = 0
    const val PHASE_HEATING = 0x0201

    data class Etat(val etat: String, val label: String)

    fun phaseEtat(phase: Int): Etat {
        val stage = phase shr 8
        return when {
            phase == PHASE_OFF -> Etat("eteint", "Éteint")
            phase == PHASE_HEATING -> Etat("chauffe", "En chauffe")
            stage == 0x01 -> Etat("allumage", "Allumage")
            phase == 0x0200 || phase == 0x0401 -> Etat("nettoyage", "Nettoyage")
            stage == 0x08 -> Etat("extinction", "Extinction")
            else -> Etat("inconnu", "Phase %04x".format(phase))
        }
    }

    private val ERREURS = mapOf(
        0 to "Aucune erreur",
        1 to "Échec de l'allumage",
        2 to "Défaut d'aspiration",
        3 to "Arrivée d'air insuffisante",
        4 to "Température de l'eau",
        5 to "Plus de pellets",
        6 to "Pressostat défectueux",
        7 to "Erreur inconnue",
        8 to "Coupure de courant",
        9 to "Panne du moteur des fumées",
        10 to "Surtension de la carte",
        11 to "Date expirée",
        12 to "Erreur inconnue",
        13 to "Erreur du capteur de régulation d'aspiration",
        14 to "Surchauffe",
    )

    fun errorLabel(code: Int) = ERREURS[code] ?: "Erreur $code"

    private fun isHeating(phase: Int, realPower: Int) = phase == PHASE_HEATING && realPower >= 1

    /** Registres en plus, confirmés seulement en connexion locale : testés, masqués s'ils ne répondent pas. */
    class Extra(val name: String, val register: String, val parse: (String) -> Any)

    val EXTRAS = listOf(
        Extra("pcbTemp", "RDF000") { Duepi.value4(it) },
        Extra("fanRpm", "REF000") { Duepi.value4(it) * 10 },
        Extra("pressureOk", "RC0000") { Duepi.value4(it) == 0x0100 },
        Extra("hoursTotal", "RED000") { Duepi.value6(it) },
        Extra("hoursPartial", "REE000") { Duepi.value6(it) },
    )

    /** État lu, au format attendu par l'interface (même forme que l'ancienne API /api/status). */
    fun readStatus(opts: RelayOptions, skip: Collection<String> = emptyList()): JSONObject =
        withSession(opts.withTimeout(25000)) { s ->
            val phase = Duepi.value4(s.read("RD9000"))
            val powerSetting = Duepi.value4(s.read("RD3000"))
            val realPower = Duepi.value4(s.read("RD4000"))
            val room = Duepi.value4(s.read("RD1000")) / 10.0
            val fumes = Duepi.value4(s.read("RD0000"))
            val errorCode = Duepi.value4(s.read("RDA000"))

            val extras = JSONObject()
            val unsupported = JSONArray()
            for (extra in EXTRAS) {
                if (extra.name in skip) continue
                try {
                    extras.put(extra.name, extra.parse(s.read(extra.register)))
                } catch (e: DuepiException) {
                    unsupported.put(extra.name)
                    // Après un silence, une réponse tardive pourrait être prise pour la suivante : on s'arrête là.
                    if (e is TransportException) break
                }
            }

            val etat = phaseEtat(phase)
            JSONObject()
                .put("phase", phase)
                .put("etat", etat.etat)
                .put("etatLabel", etat.label)
                .put("roomTemperature", room)
                .put("fumesTemperature", fumes)
                .put("powerSetting", powerSetting)
                .put("realPower", realPower)
                .put("errorCode", errorCode)
                .put("errorLabel", errorLabel(errorCode))
                .put("extras", extras)
                .put("unsupported", unsupported)
                .put("readAt", Instant.now().toString())
        }

    sealed class TurnOn(val result: String) {
        /** La commande d'allumage est partie. */
        object Allumage : TurnOn("allumage")
        /** Déjà en chauffe : puissance appliquée. */
        object DejaEnMarche : TurnOn("deja-en-marche")
        object DejaEnAllumage : TurnOn("deja-en-allumage")
        class Refuse(val reason: String) : TurnOn("refuse")
    }

    /** Allume un poêle éteint avec la puissance donnée. */
    fun turnOn(opts: RelayOptions, power: Int): TurnOn {
        val command = Duepi.powerCommand(power)
        return withSession(opts) { s ->
            val core = readCore(s)
            when {
                isHeating(core.phase, core.realPower) -> {
                    s.write(command)
                    TurnOn.DejaEnMarche
                }
                core.phase == PHASE_OFF -> when {
                    core.error != 0 -> TurnOn.Refuse("Le poêle signale : ${errorLabel(core.error)}. Réinitialise l'alarme d'abord.")
                    core.realPower != 0 -> TurnOn.Refuse("Le poêle n'est pas complètement arrêté.")
                    else -> {
                        s.write(command)
                        TurnOn.Allumage
                    }
                }
                core.phase shr 8 == 0x01 -> TurnOn.DejaEnAllumage
                else -> TurnOn.Refuse("Le poêle est occupé (${phaseEtat(core.phase).label}). Réessaie dans quelques minutes.")
            }
        }
    }

    fun turnOff(opts: RelayOptions) = withSession(opts) { it.write(Duepi.OFF_COMMAND) }

    /** Envoie la puissance si le poêle chauffe. Renvoie false s'il ne chauffe pas (rien n'est envoyé). */
    fun setPower(opts: RelayOptions, power: Int) = sendIfHeating(opts, Duepi.powerCommand(power))

    /** Envoie la consigne si le poêle chauffe. Renvoie false s'il ne chauffe pas (rien n'est envoyé). */
    fun setSetpoint(opts: RelayOptions, temperature: Int) = sendIfHeating(opts, Duepi.setpointCommand(temperature))

    fun resetAlarm(opts: RelayOptions) = withSession(opts) { it.write(Duepi.RESET_ALARM_COMMAND) }

    /** Mode Auto (même règle que src/stove.ts) : plus la pièce est loin sous la consigne, plus c'est fort. */
    fun autoPower(setpoint: Int, room: Double): Int {
        val gap = setpoint - room
        return when {
            gap >= 2.0 -> 5
            gap >= 1.5 -> 4
            gap >= 1.0 -> 3
            gap >= 0.5 -> 2
            else -> 1
        }
    }

    /** En chauffe stable, règle la puissance selon l'écart à la consigne. Renvoie la puissance envoyée, ou null. */
    fun applyAuto(opts: RelayOptions, setpoint: Int): Int? = withSession(opts) { s ->
        val core = readCore(s)
        if (!isHeating(core.phase, core.realPower)) return@withSession null
        val current = Duepi.value4(s.read("RD3000"))
        val power = autoPower(setpoint, Duepi.value4(s.read("RD1000")) / 10.0)
        if (power != current) s.write(Duepi.powerCommand(power))
        power
    }

    private fun sendIfHeating(opts: RelayOptions, command: String): Boolean = withSession(opts) { s ->
        val core = readCore(s)
        if (!isHeating(core.phase, core.realPower)) return@withSession false
        s.write(command)
        true
    }

    private class Core(val phase: Int, val realPower: Int, val error: Int)

    private fun readCore(s: Session) = Core(
        phase = Duepi.value4(s.read("RD9000")),
        realPower = Duepi.value4(s.read("RD4000")),
        error = Duepi.value4(s.read("RDA000")),
    )
}
