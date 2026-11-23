// Plages horaires façon Chacon : début, fin, jours cochés, interrupteur.
// Elles sont déclenchées par le serveur (scripts/tick.ts, src/scheduler.ts) ; ici on les vérifie seulement
// avant de les envoyer, avec les mêmes règles que le serveur.

package app.mydpremote

import org.json.JSONArray
import org.json.JSONObject

data class Plage(
    val id: String,
    val nom: String,
    /** "HH:MM" */
    val debut: String,
    /** "HH:MM". Si elle est avant le début, la plage finit le lendemain. */
    val fin: String,
    /** 7 cases, lundi en premier. Ce sont les jours où la plage commence. */
    val jours: List<Boolean>,
    val actif: Boolean,
) {
    fun toJson(): JSONObject = JSONObject()
        .put("id", id).put("nom", nom).put("debut", debut).put("fin", fin)
        .put("jours", JSONArray(jours)).put("actif", actif)
}

object Scheduler {
    private val HHMM = Regex("^([01]\\d|2[0-3]):([0-5]\\d)$")
    private val ID = Regex("^[a-z0-9-]{1,40}$", RegexOption.IGNORE_CASE)

    private fun checkTime(hhmm: String) {
        if (!HHMM.matches(hhmm)) throw IllegalArgumentException("Heure invalide : $hhmm")
    }

    fun toJson(plages: List<Plage>) = JSONArray().apply { plages.forEach { put(it.toJson()) } }

    /** Vérifie et nettoie des plages. Lève IllegalArgumentException si quelque chose ne va pas. */
    fun validatePlages(input: JSONArray): List<Plage> {
        require(input.length() <= 20) { "Liste de plages invalide" }
        val ids = mutableSetOf<String>()
        return List(input.length()) { i ->
            val p = input.optJSONObject(i) ?: throw IllegalArgumentException("Plage ${i + 1} invalide")
            val id = p.optString("id")
            require(ID.matches(id) && ids.add(id)) { "Plage ${i + 1} : identifiant invalide" }
            val nom = p.optString("nom").take(30).ifBlank { "Plage ${i + 1}" }
            val debut = p.optString("debut")
            val fin = p.optString("fin")
            checkTime(debut)
            checkTime(fin)
            require(debut != fin) { "Plage « $nom » : le début et la fin sont identiques" }
            val jours = p.optJSONArray("jours")
            require(jours != null && jours.length() == 7) { "Plage ${i + 1} : jours invalides" }
            Plage(id, nom, debut, fin, List(7) { jours.optBoolean(it) }, p.optBoolean("actif"))
        }
    }

    fun parsePlages(json: String): List<Plage> = validatePlages(JSONArray(json))
}
