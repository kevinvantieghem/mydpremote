// Fichiers partagés avec le serveur (dépôt GitHub, dossier donnees/) : plages et préférences.
// Le workflow GitHub (.github/workflows/poele.yml) les lit toutes les 5 minutes et agit sur le poêle,
// même téléphone éteint ou sans internet.

package app.mydpremote

import org.json.JSONObject
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.util.Base64

/** Erreur renvoyée par le serveur des horaires (message lisible). */
class CloudException(message: String) : Exception(message)

interface Cloud {
    /** Contenu du fichier, ou null s'il n'existe pas. IOException si injoignable, CloudException si refusé. */
    fun read(name: String): String?
    fun write(name: String, content: String)
}

/** API Contents de GitHub, avec un jeton limité au dépôt. */
class GitHubCloud(private val repo: String, private val token: String) : Cloud {
    private fun url(name: String) = "https://api.github.com/repos/$repo/contents/donnees/$name"

    private fun call(method: String, url: String, body: String? = null): Pair<Int, String> {
        if (repo.isBlank() || token.isBlank()) throw IOException("dépôt non configuré")
        val conn = URL(url).openConnection() as HttpURLConnection
        try {
            conn.requestMethod = method
            conn.useCaches = false
            conn.connectTimeout = 10_000
            conn.readTimeout = 15_000
            conn.setRequestProperty("Authorization", "Bearer $token")
            conn.setRequestProperty("Accept", "application/vnd.github+json")
            conn.setRequestProperty("X-GitHub-Api-Version", "2022-11-28")
            if (body != null) {
                conn.doOutput = true
                conn.setRequestProperty("Content-Type", "application/json; charset=utf-8")
                conn.outputStream.use { it.write(body.toByteArray(Charsets.UTF_8)) }
            }
            val status = conn.responseCode
            val stream = if (status >= 400) conn.errorStream else conn.inputStream
            return status to (stream?.bufferedReader(Charsets.UTF_8)?.use { it.readText() } ?: "")
        } finally {
            conn.disconnect()
        }
    }

    private fun fail(status: Int, text: String): Nothing {
        val message = runCatching { JSONObject(text).getString("message") }.getOrNull()
        throw CloudException(
            when (status) {
                401 -> "jeton GitHub refusé ou expiré"
                403, 404 -> "accès au dépôt refusé (${message ?: status})"
                else -> message ?: "erreur $status"
            },
        )
    }

    /** (contenu, sha) ou null si le fichier n'existe pas. */
    private fun fetch(name: String): Pair<String, String>? {
        val (status, text) = call("GET", url(name))
        if (status == 404) return null
        if (status !in 200..299) fail(status, text)
        val o = JSONObject(text)
        val bytes = Base64.getMimeDecoder().decode(o.getString("content"))
        return String(bytes, Charsets.UTF_8) to o.getString("sha")
    }

    override fun read(name: String): String? = fetch(name)?.first

    override fun write(name: String, content: String) {
        // Un autre envoi a pu passer entre-temps (sha périmé) : on relit et on réessaie une fois.
        repeat(2) { attempt ->
            val current = fetch(name)
            if (current?.first == content) return
            val body = JSONObject()
                .put("message", "App : $name")
                .put("content", Base64.getEncoder().encodeToString(content.toByteArray(Charsets.UTF_8)))
                .putOpt("sha", current?.second)
            val (status, text) = call("PUT", url(name), body.toString())
            if (status in 200..299) return
            if (attempt == 1 || status !in setOf(409, 422)) fail(status, text)
        }
    }
}
