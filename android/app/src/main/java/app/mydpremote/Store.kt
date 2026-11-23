// Stockage local de l'app (réglages, plages, état), en JSON dans des SharedPreferences.

package app.mydpremote

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject

/** Clé/valeur texte : SharedPreferences sur le téléphone, une Map dans les tests. */
interface KeyValue {
    fun get(key: String): String?
    fun put(key: String, value: String?)
}

class PrefsKeyValue(context: Context) : KeyValue {
    private val prefs = context.getSharedPreferences("dpremote", Context.MODE_PRIVATE)
    override fun get(key: String): String? = prefs.getString(key, null)
    override fun put(key: String, value: String?) {
        prefs.edit().apply { if (value == null) remove(key) else putString(key, value) }.commit()
    }
}

class MemoryKeyValue : KeyValue {
    private val map = mutableMapOf<String, String>()
    override fun get(key: String) = map[key]
    override fun put(key: String, value: String?) {
        if (value == null) map.remove(key) else map[key] = value
    }
}

data class Config(
    val power: Int = 3,
    val setpoint: Int = 21,
    /** Mode Auto : la puissance suit l'écart entre la pièce et la consigne. */
    val auto: Boolean = false,
    /** La consigne attend que le poêle soit en chauffe stable pour partir. */
    val pendingSetpoint: Boolean = false,
    val pendingSince: Long? = null,
    val lastIgnition: Long? = null,
    val offAt: Long? = null,
) {
    fun toJson(): JSONObject = JSONObject()
        .put("power", power).put("setpoint", setpoint).put("auto", auto).put("pendingSetpoint", pendingSetpoint)
        .putOpt("pendingSince", pendingSince).putOpt("lastIgnition", lastIgnition).putOpt("offAt", offAt)

    companion object {
        fun fromJson(o: JSONObject) = Config(
            power = o.optInt("power", 3),
            setpoint = o.optInt("setpoint", 21),
            auto = o.optBoolean("auto"),
            pendingSetpoint = o.optBoolean("pendingSetpoint"),
            pendingSince = o.optLongOrNull("pendingSince"),
            lastIgnition = o.optLongOrNull("lastIgnition"),
            offAt = o.optLongOrNull("offAt"),
        )

        private fun JSONObject.optLongOrNull(key: String) = if (has(key) && !isNull(key)) getLong(key) else null
    }
}

data class Device(val relayHost: String, val relayPort: Int, val deviceCode: String)

class Store(private val kv: KeyValue, private val defaultDevice: Device) {
    private val lock = Any()

    var config: Config
        get() = kv.get("config")?.let { runCatching { Config.fromJson(JSONObject(it)) }.getOrNull() } ?: Config()
        set(value) = kv.put("config", value.toJson().toString())

    /** Modifie la config de façon atomique (l'interface et les alarmes peuvent écrire en même temps). */
    fun updateConfig(change: (Config) -> Config): Config = synchronized(lock) { change(config).also { config = it } }

    /** Plages enregistrées sur le téléphone par la version 1.1 (avant le serveur), ou null. */
    var localPlages: List<Plage>?
        get() = kv.get("plages")?.let { runCatching { Scheduler.parsePlages(it) }.getOrNull() }
        set(value) = kv.put("plages", value?.let { Scheduler.toJson(it).toString() })

    var plagesMigrated: Boolean
        get() = kv.get("plagesMigrated") == "1"
        set(value) = kv.put("plagesMigrated", if (value) "1" else null)

    var unsupported: List<String>
        get() = kv.get("unsupported")?.let { s ->
            runCatching { JSONArray(s).let { a -> List(a.length()) { a.getString(it) } } }.getOrNull()
        } ?: emptyList()
        set(value) = kv.put("unsupported", if (value.isEmpty()) null else JSONArray(value).toString())

    var device: Device
        get() = kv.get("device")?.let { s ->
            runCatching {
                JSONObject(s).let { Device(it.getString("relayHost"), it.getInt("relayPort"), it.getString("deviceCode")) }
            }.getOrNull()
        } ?: defaultDevice
        set(value) = kv.put(
            "device",
            JSONObject().put("relayHost", value.relayHost).put("relayPort", value.relayPort)
                .put("deviceCode", value.deviceCode).toString(),
        )

    /** Dernière lecture réussie du poêle (ms), pour l'écran Réglages. */
    var lastContact: Long?
        get() = kv.get("lastContact")?.toLongOrNull()
        set(value) = kv.put("lastContact", value?.toString())
}
