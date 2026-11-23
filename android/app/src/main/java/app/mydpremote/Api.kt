// Logique de l'app, appelée par l'interface (pont JavaScript).
// Le téléphone parle directement au poêle ; les plages et le mode Auto sont exécutés
// par GitHub Actions (scripts/tick.ts), pour marcher même téléphone sans internet.

package app.mydpremote

import android.util.Log
import org.json.JSONArray
import org.json.JSONException
import org.json.JSONObject
import java.time.Instant

/** Effets côté Android déclenchés par la logique (vérifications en arrière-plan). */
interface Hooks {
    /** Une consigne attend la chauffe : programmer des vérifications. */
    fun setpointPending()
}

class HttpError(val status: Int, message: String) : Exception(message)

class Api(
    private val store: Store,
    private val hooks: Hooks,
    private val cloud: Cloud,
    private val clock: () -> Instant = Instant::now,
    private val connector: (Device) -> () -> Transport = { d -> { SocketTransport(d.relayHost, d.relayPort) } },
) {
    companion object {
        const val IGNITION_COOLDOWN_MS = 60_000L
        const val OFF_LATCH_MS = 10 * 60_000L
        const val PENDING_SETPOINT_MS = 60 * 60_000L
        private const val TAG = "DPRemote"
        private val HOST = Regex("^[A-Za-z0-9.-]{1,253}$")
        private val CODE = Regex("^[A-Za-z0-9]{1,64}$")
        private const val PLAGES = "plages.json"
        private const val PREFS = "prefs.json"
        private const val NL = "\n"
    }

    class Reply(val status: Int, val body: String)

    private fun now() = clock().toEpochMilli()
    private fun ago(at: Long?, ms: Long) = at != null && now() - at < ms

    private fun relay(): RelayOptions {
        val d = store.device
        if (d.deviceCode.isBlank() || d.relayHost.isBlank()) {
            throw HttpError(400, "Configuration incomplète : renseigne le serveur et le code du boîtier dans Réglages.")
        }
        return RelayOptions(d.deviceCode, connect = connector(d))
    }

    /** Traite une requête de l'interface. Ne lève jamais : les erreurs deviennent un statut + message. */
    fun handle(method: String, path: String, body: String?): Reply = try {
        Reply(200, route(method, path, body).toString())
    } catch (e: HttpError) {
        error(e.status, e.message)
    } catch (e: DuepiException) {
        error(502, e.message)
    } catch (e: IllegalArgumentException) {
        error(400, e.message)
    } catch (e: JSONException) {
        error(400, "Requête invalide")
    } catch (e: Exception) {
        Log.e(TAG, "Erreur inattendue", e)
        error(500, "Erreur inattendue.")
    }

    private fun error(status: Int, message: String?) = Reply(status, JSONObject().put("error", message ?: "Erreur").toString())

    private fun intIn(value: Any?, min: Int, max: Int, what: String): Int {
        val n = (value as? Number)?.toDouble()
        if (n == null || n != Math.floor(n) || n < min || n > max) throw HttpError(400, "$what doit être entre $min et $max.")
        return n.toInt()
    }

    private fun route(method: String, path: String, body: String?): Any {
        val json = { JSONObject(body ?: "{}") }
        return when ("$method $path") {
            "GET /api/status" -> {
                val known = store.unsupported
                val status = Stove.readStatus(relay(), known)
                store.lastContact = now()
                val fresh = status.getJSONArray("unsupported").let { a -> List(a.length()) { a.getString(it) } }
                    .filter { it !in known }
                if (fresh.isNotEmpty()) store.unsupported = known + fresh
                status.put("unsupported", JSONArray(known + fresh)).put("config", store.config.toJson())
            }

            "POST /api/on" -> {
                val config = store.config
                if (ago(config.lastIgnition, IGNITION_COOLDOWN_MS)) {
                    throw HttpError(409, "Un allumage a été demandé il y a moins d'une minute. Patiente un peu.")
                }
                val result = Stove.turnOn(relay(), config.power)
                if (result is Stove.TurnOn.Refuse) throw HttpError(409, result.reason)
                store.updateConfig { started(it, result) }
                hooks.setpointPending()
                JSONObject().put("result", result.result)
            }

            "POST /api/off" -> {
                Stove.turnOff(relay())
                store.updateConfig(::stopped)
                JSONObject().put("ok", true)
            }

            "POST /api/power" -> {
                val raw = json().opt("power")
                val latched = ago(store.config.offAt, OFF_LATCH_MS)
                if (raw == "auto") {
                    val config = store.updateConfig { it.copy(auto = true) }
                    val power = if (latched) null else Stove.applyAuto(relay(), config.setpoint)
                    JSONObject().put("sent", power != null).putOpt("power", power).putOpt("warning", syncPrefs(config))
                } else {
                    val power = intIn(raw, Duepi.MIN_POWER, Duepi.MAX_POWER, "La puissance")
                    val sent = !latched && Stove.setPower(relay(), power)
                    val config = store.updateConfig { it.copy(power = power, auto = false) }
                    JSONObject().put("sent", sent).putOpt("warning", syncPrefs(config))
                }
            }

            "POST /api/setpoint" -> {
                val setpoint = intIn(json().opt("temperature"), Duepi.MIN_TEMPERATURE, Duepi.MAX_TEMPERATURE, "La consigne")
                val latched = ago(store.config.offAt, OFF_LATCH_MS)
                val sent = !latched && Stove.setSetpoint(relay(), setpoint)
                val pending = !sent && !latched
                store.updateConfig {
                    it.copy(setpoint = setpoint, pendingSetpoint = pending, pendingSince = if (pending) now() else it.pendingSince)
                }
                if (pending) hooks.setpointPending()
                JSONObject().put("sent", sent).putOpt("warning", syncPrefs(store.config))
            }

            "POST /api/reset-alarm" -> {
                Stove.resetAlarm(relay())
                JSONObject().put("ok", true)
            }

            "GET /api/schedules" -> {
                migratePlages()
                Scheduler.toJson(Scheduler.validatePlages(JSONArray(cloud { it.read(PLAGES) } ?: "[]")))
            }

            "PUT /api/schedules" -> {
                val plages = Scheduler.validatePlages(JSONArray(body ?: "[]"))
                cloud { it.write(PLAGES, plagesFile(plages)) }
                Scheduler.toJson(plages)
            }

            "GET /api/settings" -> settingsJson()

            "PUT /api/settings" -> {
                val o = json()
                val host = o.optString("relayHost").trim()
                val code = o.optString("deviceCode").trim()
                val port = intIn(o.opt("relayPort"), 1, 65535, "Le port")
                if (!HOST.matches(host)) throw HttpError(400, "Adresse du serveur invalide.")
                if (!CODE.matches(code)) throw HttpError(400, "Code du boîtier invalide (lettres et chiffres seulement).")
                val changed = store.device != Device(host, port, code)
                store.device = Device(host, port, code)
                if (changed) store.unsupported = emptyList()
                settingsJson()
            }

            "POST /api/redetect" -> {
                store.unsupported = emptyList()
                JSONObject().put("ok", true)
            }

            else -> throw HttpError(404, "Introuvable")
        }
    }

    private fun settingsJson(): JSONObject {
        val d = store.device
        return JSONObject()
            .put("relayHost", d.relayHost)
            .put("relayPort", d.relayPort)
            .put("deviceCode", d.deviceCode)
            .put("unsupported", JSONArray(store.unsupported))
            .put("extras", JSONArray(Stove.EXTRAS.map { it.name }))
            .putOpt("lastContact", store.lastContact?.let { Instant.ofEpochMilli(it).toString() })
    }

    private fun started(config: Config, result: Stove.TurnOn) = config.copy(
        offAt = null,
        lastIgnition = if (result is Stove.TurnOn.Allumage) now() else config.lastIgnition,
        // La consigne choisie part dès que le poêle est en chauffe stable.
        pendingSetpoint = true,
        pendingSince = now(),
    )

    private fun stopped(config: Config) = config.copy(pendingSetpoint = false, offAt = now())

    // ---------- Serveur des plages (dépôt GitHub) ----------

    /** Lit ou écrit un fichier du serveur ; erreurs traduites pour l'interface. */
    private fun <T> cloud(action: (Cloud) -> T): T = try {
        action(cloud)
    } catch (e: java.io.IOException) {
        throw HttpError(502, "Serveur des horaires injoignable. Vérifie ta connexion internet.")
    } catch (e: CloudException) {
        throw HttpError(502, "Serveur des horaires : ${e.message}")
    }

    /** Envoie puissance, Auto et consigne au serveur (utilisés par les plages et le mode Auto). Renvoie un avertissement si ça échoue. */
    private fun syncPrefs(config: Config): String? = try {
        val prefs = JSONObject().put("power", config.power).put("setpoint", config.setpoint).put("auto", config.auto)
        cloud { it.write(PREFS, prefs.toString() + NL) }
        null
    } catch (e: HttpError) {
        "Les horaires n'ont pas reçu ce réglage : ${e.message}"
    }

    /** Une seule fois : les plages réglées sur le téléphone (version 1.1) partent vers le serveur. */
    private fun migratePlages() {
        if (store.plagesMigrated) return
        store.localPlages?.let { p -> cloud { it.write(PLAGES, plagesFile(p)) } }
        store.plagesMigrated = true
    }

    private fun plagesFile(plages: List<Plage>) = Scheduler.toJson(plages).toString(2) + NL

    /** Envoie la consigne en attente si le poêle chauffe. Renvoie true s'il faut revérifier plus tard. */
    fun runPendingSetpoint(): Boolean {
        val config = store.config
        if (!config.pendingSetpoint) return false
        if (!ago(config.pendingSince, PENDING_SETPOINT_MS)) {
            store.updateConfig { it.copy(pendingSetpoint = false) }
            return false
        }
        return try {
            if (Stove.setSetpoint(relay(), config.setpoint)) {
                Log.i(TAG, "Consigne ${config.setpoint} °C envoyée")
                store.updateConfig { it.copy(pendingSetpoint = false) }
                false
            } else {
                true
            }
        } catch (e: Exception) {
            Log.w(TAG, "Consigne en attente : ${e.message}")
            e !is HttpError
        }
    }
}
