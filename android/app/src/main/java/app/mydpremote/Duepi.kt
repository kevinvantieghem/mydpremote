// Protocole du serveur relais Duepi (celui qu'utilise l'app MyDPremote).
//
// Le boîtier Wi-Fi du poêle reste connecté à un relais duepiwebserverN.com.
// Un client qui se présente comme "master" avec le code du boîtier (QR code)
// échange avec lui des trames chiffrées :
//   requête = ESC + base64(IV16 || AES-128-CBC(clé, IV, commande + somme)) + "&"
//   clé     = MD5(code) XOR KEY_MASK
// Portage de src/duepi.ts. Le code du boîtier n'apparaît jamais dans les erreurs.

package app.mydpremote

import java.io.InputStream
import java.io.OutputStream
import java.net.InetSocketAddress
import java.net.Socket
import java.net.SocketTimeoutException
import java.security.MessageDigest
import java.security.SecureRandom
import java.util.Base64
import javax.crypto.Cipher
import javax.crypto.spec.IvParameterSpec
import javax.crypto.spec.SecretKeySpec

open class DuepiException(message: String) : Exception(message)
/** Le relais ne répond pas ou a coupé la connexion. */
class TransportException(message: String) : DuepiException(message)
/** Réponse illisible (mauvais code du boîtier, somme fausse, registre inconnu). */
class ProtocolException(message: String) : DuepiException(message)

object Duepi {
    private val KEY_MASK = hex("23FADC18A422678312C86AC29281AC01")
    private const val ESC: Byte = 0x1b
    private const val AMP: Byte = 0x26
    private const val BLOCK = 16
    const val MAX_FRAME_BYTES = 512

    const val CONNECT_TIMEOUT = 5000
    const val FRAME_TIMEOUT = 4000
    const val LOGIN_DELAY = 500L
    const val DRAIN_TIMEOUT = 50

    const val MIN_POWER = 1
    const val MAX_POWER = 5
    const val MIN_TEMPERATURE = 5
    const val MAX_TEMPERATURE = 40
    const val OFF_COMMAND = "RF0000"
    const val RESET_ALARM_COMMAND = "RD6000"

    val READ_COMMAND = Regex("^R[CDE][0-9A-F]{4}$")
    val WRITE_COMMAND = Regex("^RF00[0-5]0$|^RF2[0-9A-F]{2}0$|^RD6000$")
    val CLEARTEXT_FRAME = Regex("^\u001b[0-9A-Fa-f]{8}&$")
    private val BASE64 = Regex("^[A-Za-z0-9+/]*={0,2}$")
    private val HEX6 = Regex("^[0-9A-Fa-f]{6}$")
    private val random = SecureRandom()

    fun hex(s: String) = ByteArray(s.length / 2) { s.substring(it * 2, it * 2 + 2).toInt(16).toByte() }

    fun deriveKey(deviceCode: String): ByteArray {
        val digest = MessageDigest.getInstance("MD5").digest(deviceCode.toByteArray(Charsets.UTF_8))
        return ByteArray(16) { (digest[it].toInt() xor KEY_MASK[it].toInt()).toByte() }
    }

    /** Somme des octets modulo 256, en 2 chiffres hexadécimaux majuscules. */
    fun checksum(text: String): String {
        var sum = 0
        for (b in text.toByteArray(Charsets.ISO_8859_1)) sum += b.toInt() and 0xff
        return "%02X".format(sum and 0xff)
    }

    fun encodeFrame(key: ByteArray, command: String, iv: ByteArray? = null): ByteArray {
        require(command.length == 6) { "Une commande relais fait 6 caractères" }
        val plaintext = ByteArray(BLOCK) // complété par des NUL
        (command + checksum(command)).toByteArray(Charsets.ISO_8859_1).copyInto(plaintext)
        val vector = iv ?: ByteArray(BLOCK).also { random.nextBytes(it) }
        val cipher = Cipher.getInstance("AES/CBC/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, SecretKeySpec(key, "AES"), IvParameterSpec(vector))
        val body = Base64.getEncoder().encode(vector + cipher.doFinal(plaintext))
        return byteArrayOf(ESC) + body + byteArrayOf(AMP)
    }

    fun decodeFrame(key: ByteArray, frame: ByteArray): String {
        var start = 0
        var end = frame.size
        if (end > 0 && frame[0] == ESC) start++
        if (end > start && frame[end - 1] == AMP) end--
        val body = String(frame, start, end - start, Charsets.US_ASCII).trim()
        if (!BASE64.matches(body)) throw ProtocolException("Réponse du relais illisible (base64)")
        val raw = try {
            Base64.getDecoder().decode(body)
        } catch (e: IllegalArgumentException) {
            throw ProtocolException("Réponse du relais illisible (base64)")
        }
        if (raw.size < 2 * BLOCK || raw.size % BLOCK != 0) throw ProtocolException("Réponse du relais de longueur invalide")
        val cipher = Cipher.getInstance("AES/CBC/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, SecretKeySpec(key, "AES"), IvParameterSpec(raw.copyOfRange(0, BLOCK)))
        val plaintext = cipher.doFinal(raw, BLOCK, raw.size - BLOCK)
        val nul = plaintext.indexOf(0)
        return String(plaintext, 0, if (nul == -1) plaintext.size else nul, Charsets.ISO_8859_1)
    }

    /** Vérifie la somme d'une réponse (6 caractères de données + 2 de somme) et renvoie les données. */
    fun parseReply(plaintext: String): String {
        if (plaintext.length != 8) throw ProtocolException("Réponse du relais de taille inattendue")
        val data = plaintext.substring(0, 6)
        if (checksum(data) != plaintext.substring(6).uppercase()) throw ProtocolException("Somme de contrôle de la réponse fausse")
        if (!HEX6.matches(data)) throw ProtocolException("Réponse non hexadécimale")
        return data
    }

    /** Valeur sur 4 chiffres hexadécimaux (la plupart des registres). */
    fun value4(data: String) = data.substring(0, 4).toInt(16)
    /** Valeur sur 6 chiffres hexadécimaux (compteurs d'heures). */
    fun value6(data: String) = data.toInt(16)

    fun powerCommand(power: Int): String {
        if (power !in MIN_POWER..MAX_POWER) throw IllegalArgumentException("Puissance entre $MIN_POWER et $MAX_POWER")
        return "RF00${power}0"
    }

    fun setpointCommand(temperature: Int): String {
        if (temperature !in MIN_TEMPERATURE..MAX_TEMPERATURE) {
            throw IllegalArgumentException("Consigne entre $MIN_TEMPERATURE et $MAX_TEMPERATURE °C")
        }
        return "RF2%02X0".format(temperature)
    }
}

/** Connexion TCP brute. */
interface Transport : AutoCloseable {
    fun write(bytes: ByteArray)
    /** Renvoie null si rien n'arrive avant le délai ; lève TransportException si la connexion est fermée. */
    fun read(timeoutMs: Int): ByteArray?
}

class SocketTransport(host: String, port: Int) : Transport {
    private val socket = Socket()
    private val input: InputStream
    private val output: OutputStream
    private val chunk = ByteArray(1024)

    init {
        try {
            socket.connect(InetSocketAddress(host, port), Duepi.CONNECT_TIMEOUT)
        } catch (e: Exception) {
            socket.close()
            throw TransportException("Connexion au relais Duepi impossible")
        }
        input = socket.getInputStream()
        output = socket.getOutputStream()
    }

    override fun write(bytes: ByteArray) {
        try {
            output.write(bytes)
            output.flush()
        } catch (e: Exception) {
            throw TransportException("Connexion au relais Duepi coupée")
        }
    }

    override fun read(timeoutMs: Int): ByteArray? {
        socket.soTimeout = timeoutMs.coerceAtLeast(1)
        val n = try {
            input.read(chunk)
        } catch (e: SocketTimeoutException) {
            return null
        } catch (e: Exception) {
            throw TransportException("Connexion au relais Duepi coupée")
        }
        if (n < 0) throw TransportException("Le relais Duepi a fermé la connexion")
        return chunk.copyOf(n)
    }

    override fun close() = socket.close()
}

class RelayOptions(
    val deviceCode: String,
    val timeoutMs: Long = 15000,
    val loginDelayMs: Long = Duepi.LOGIN_DELAY,
    val connect: () -> Transport,
) {
    fun withTimeout(ms: Long) = RelayOptions(deviceCode, ms, loginDelayMs, connect)
}

class Session(private val transport: Transport, private val key: ByteArray, private val deadline: Long) {
    private var buffer = ByteArray(0)

    fun read(register: String): String {
        require(Duepi.READ_COMMAND.matches(register)) { "Lecture non autorisée : $register" }
        return Duepi.parseReply(exchange(register))
    }

    /** Une réponse ne prouve que la livraison de la commande (somme correcte). */
    fun write(command: String) {
        require(Duepi.WRITE_COMMAND.matches(command)) { "Écriture non autorisée : $command" }
        Duepi.parseReply(exchange(command))
    }

    private fun exchange(command: String): String {
        transport.write(Duepi.encodeFrame(key, command))
        return Duepi.decodeFrame(key, readFrame(command))
    }

    /** Renvoie la prochaine trame chiffrée, en ignorant les trames en clair que le relais intercale. */
    private fun readFrame(command: String): ByteArray {
        while (true) {
            var end = buffer.indexOf(0x26)
            while (end != -1) {
                val start = buffer.lastIndexOf(0x1b, end)
                if (start == -1) throw TransportException("Réponse à $command sans début de trame")
                val frame = buffer.copyOfRange(start, end + 1)
                buffer = buffer.copyOfRange(end + 1, buffer.size)
                if (!Duepi.CLEARTEXT_FRAME.matches(String(frame, Charsets.ISO_8859_1))) return frame
                end = buffer.indexOf(0x26)
            }
            if (buffer.size > Duepi.MAX_FRAME_BYTES) throw TransportException("Réponse à $command trop longue")
            val remaining = deadline - System.currentTimeMillis()
            if (remaining <= 0) throw TransportException("Le poêle met trop de temps à répondre")
            val chunk = transport.read(minOf(Duepi.FRAME_TIMEOUT.toLong(), remaining).toInt())
                ?: throw TransportException(
                    if (remaining <= Duepi.FRAME_TIMEOUT) "Le poêle met trop de temps à répondre" else "Pas de réponse du poêle à $command",
                )
            buffer += chunk
        }
    }

    private fun ByteArray.indexOf(b: Int, from: Int = 0): Int {
        for (i in from until size) if (this[i].toInt() == b) return i
        return -1
    }

    private fun ByteArray.lastIndexOf(b: Int, before: Int): Int {
        for (i in before downTo 0) if (this[i].toInt() == b) return i
        return -1
    }
}

/** Une seule connexion au relais à la fois dans l'app (interface et plages peuvent tomber ensemble). */
private val sessionLock = Any()

/** Ouvre une connexion, se connecte comme master, exécute l'opération puis ferme. Bloquant. */
fun <T> withSession(opts: RelayOptions, operation: (Session) -> T): T = synchronized(sessionLock) {
    val deadline = System.currentTimeMillis() + opts.timeoutMs
    opts.connect().use { transport ->
        transport.write("master:${opts.deviceCode}#".toByteArray(Charsets.UTF_8))
        Thread.sleep(opts.loginDelayMs)
        // Jette ce qui attend déjà, pour qu'une vieille réponse ne soit pas prise pour la bonne.
        var drained = 0
        while (drained++ < 64 && transport.read(Duepi.DRAIN_TIMEOUT) != null) {
            // vidage
        }
        operation(Session(transport, Duepi.deriveKey(opts.deviceCode), deadline))
    }
}
