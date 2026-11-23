package app.mydpremote

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.Instant

/** Faux poêle en mémoire : répond comme le relais Duepi et change d'état quand on lui écrit. */
class FakeStove(code: String = "TESTCODE") {
    private val key = Duepi.deriveKey(code)
    val regs = mutableMapOf(
        "RD9000" to "000000", "RD3000" to "000300", "RD4000" to "000000", "RD1000" to "00C300",
        "RD0000" to "001900", "RDA000" to "000000", "RDF000" to "002000", "REF000" to "000000",
        "RC0000" to "010000", "RED000" to "000ABC", "REE000" to "000012",
    )
    val writes = mutableListOf<String>()
    var reachable = true

    fun connect(): Transport {
        if (!reachable) throw TransportException("Connexion au relais Duepi impossible")
        return object : Transport {
            private val out = ArrayDeque<ByteArray>()
            override fun write(bytes: ByteArray) {
                if (bytes.first().toInt() != 0x1b) return // connexion "master:<code>#"
                val cmd = Duepi.decodeFrame(key, bytes).substring(0, 6)
                if (cmd.startsWith("RF") || cmd == "RD6000") {
                    writes += cmd
                    when {
                        cmd == "RF0000" -> { regs["RD9000"] = "000000"; regs["RD4000"] = "000000" }
                        cmd.startsWith("RF00") -> {
                            regs["RD3000"] = "000${cmd[4]}00"
                            if (regs["RD9000"] == "000000") regs["RD9000"] = "010100" // allume un poêle éteint
                        }
                    }
                    out += Duepi.encodeFrame(key, "002000")
                    return
                }
                regs[cmd]?.let { out += Duepi.encodeFrame(key, it) }
            }
            override fun read(timeoutMs: Int) = out.removeFirstOrNull()
            override fun close() = Unit
        }
    }

    fun heat(power: Int = 3) {
        regs["RD9000"] = "020100"; regs["RD4000"] = "000${power}00"
    }
}

/** Faux dépôt GitHub : garde les fichiers donnees/ en mémoire. */
class FakeCloud : Cloud {
    val files = mutableMapOf<String, String>()
    var reachable = true
    val calls = mutableListOf<String>()
    val plages get() = files["plages.json"] ?: "[]"
    val prefs get() = files["prefs.json"]?.let { JSONObject(it) }

    override fun read(name: String): String? {
        if (!reachable) throw java.io.IOException("hors ligne")
        calls += "read $name"
        return files[name]
    }

    override fun write(name: String, content: String) {
        if (!reachable) throw java.io.IOException("hors ligne")
        calls += "write $name"
        files[name] = content
    }
}

class ApiTest {
    private val stove = FakeStove()
    private var now = Instant.parse("2026-11-23T05:00:00Z")
    private var setpointPending = 0
    private val hooks = object : Hooks {
        override fun setpointPending() { setpointPending++ }
    }
    private val cloud = FakeCloud()
    private val store = Store(MemoryKeyValue(), Device("relais.test", 3000, "TESTCODE"))
    private val api = Api(store, hooks, cloud, { now }, { { stove.connect() } })

    private fun call(method: String, path: String, body: String? = null): Pair<Int, JSONObject> {
        val r = api.handle(method, path, body)
        return r.status to (if (r.body.startsWith("[")) JSONObject().put("list", JSONArray(r.body)) else JSONObject(r.body))
    }

    @Test
    fun `lit l'etat du poele`() {
        val (status, s) = call("GET", "/api/status")
        assertEquals(200, status)
        assertEquals("eteint", s.getString("etat"))
        assertEquals(19.5, s.getDouble("roomTemperature"), 0.0)
        assertEquals(32, s.getJSONObject("extras").getInt("pcbTemp"))
        assertTrue(s.getJSONObject("extras").getBoolean("pressureOk"))
        assertEquals(2748, s.getJSONObject("extras").getInt("hoursTotal"))
        assertEquals(3, s.getJSONObject("config").getInt("power"))
        assertTrue(store.lastContact != null)
    }

    @Test
    fun `allume, refuse un second allumage dans la minute, puis eteint`() {
        val (s1, r1) = call("POST", "/api/on")
        assertEquals(200, s1)
        assertEquals("allumage", r1.getString("result"))
        assertEquals(listOf("RF0030"), stove.writes)
        assertEquals(1, setpointPending)

        assertEquals(409, call("POST", "/api/on").first)

        now = now.plusSeconds(61)
        assertEquals("deja-en-allumage", call("POST", "/api/on").second.getString("result"))

        assertEquals(200, call("POST", "/api/off").first)
        assertEquals("RF0000", stove.writes.last())
        assertFalse(store.config.pendingSetpoint)
    }

    @Test
    fun `refuse d'allumer un poele en alarme`() {
        stove.regs["RDA000"] = "000500"
        val (status, r) = call("POST", "/api/on")
        assertEquals(409, status)
        assertTrue(r.getString("error").contains("Plus de pellets"))
        assertTrue(stove.writes.isEmpty())
    }

    @Test
    fun `poele injoignable donne une erreur lisible`() {
        stove.reachable = false
        val (status, r) = call("GET", "/api/status")
        assertEquals(502, status)
        assertEquals("Connexion au relais Duepi impossible", r.getString("error"))
    }

    @Test
    fun `puissance et consigne seulement en chauffe`() {
        assertFalse(call("POST", "/api/power", """{"power":4}""").second.getBoolean("sent"))
        assertEquals(4, store.config.power)
        assertTrue(stove.writes.isEmpty())

        assertFalse(call("POST", "/api/setpoint", """{"temperature":22}""").second.getBoolean("sent"))
        assertTrue(store.config.pendingSetpoint)

        stove.heat()
        assertTrue(call("POST", "/api/power", """{"power":5}""").second.getBoolean("sent"))
        assertTrue(call("POST", "/api/setpoint", """{"temperature":23}""").second.getBoolean("sent"))
        assertEquals(listOf("RF0050", "RF2170"), stove.writes)
        assertEquals(400, call("POST", "/api/power", """{"power":9}""").first)
    }

    @Test
    fun `pas d'ecriture dans les 10 minutes apres un arret`() {
        stove.heat()
        call("POST", "/api/off")
        assertFalse(call("POST", "/api/power", """{"power":2}""").second.getBoolean("sent"))
        assertEquals(listOf("RF0000"), stove.writes)
    }

    @Test
    fun `plages gardees par le serveur, avec migration des plages du telephone`() {
        store.localPlages = listOf(Plage("soir", "Soir", "17:30", "22:00", List(7) { true }, true))
        assertEquals("soir", call("GET", "/api/schedules").second.getJSONArray("list").getJSONObject(0).getString("id"))
        assertTrue(store.plagesMigrated)
        assertEquals(listOf("write plages.json", "read plages.json"), cloud.calls)

        val plages = """[{"id":"matin","nom":"Matin","debut":"06:30","fin":"08:30","jours":[true,true,true,true,true,true,true],"actif":true}]"""
        assertEquals(200, call("PUT", "/api/schedules", plages).first)
        assertTrue(cloud.plages.contains("matin"))
        assertEquals(400, call("PUT", "/api/schedules", """[{"id":"x","debut":"07:00","fin":"07:00","jours":[]}]""").first)

        cloud.reachable = false
        val (status, r) = call("GET", "/api/schedules")
        assertEquals(502, status)
        assertTrue(r.getString("error").contains("injoignable"))
    }

    @Test
    fun `puissance et consigne partent aussi au serveur, sans bloquer s'il est injoignable`() {
        call("POST", "/api/power", """{"power":4}""")
        assertEquals(4, cloud.prefs!!.getInt("power"))
        cloud.reachable = false
        val (status, r) = call("POST", "/api/setpoint", """{"temperature":22}""")
        assertEquals(200, status)
        assertTrue(r.getString("warning").contains("horaires"))
        assertEquals(22, store.config.setpoint)
    }

    @Test
    fun `mode Auto regle la puissance selon la piece et se coupe si on choisit une puissance`() {
        assertEquals(5, Stove.autoPower(21, 18.0))
        assertEquals(4, Stove.autoPower(21, 19.5))
        assertEquals(1, Stove.autoPower(21, 21.0))

        call("POST", "/api/setpoint", """{"temperature":21}""")
        stove.heat(3)
        stove.regs["RD1000"] = "00B400" // 18 °C
        stove.writes.clear()
        val (status, r) = call("POST", "/api/power", """{"power":"auto"}""")
        assertEquals(200, status)
        assertEquals(5, r.getInt("power"))
        assertEquals(listOf("RF0050"), stove.writes)
        assertTrue(store.config.auto)
        assertEquals(true, cloud.prefs!!.getBoolean("auto"))

        call("POST", "/api/power", """{"power":2}""")
        assertEquals(false, store.config.auto)
        assertEquals(false, cloud.prefs!!.getBoolean("auto"))
    }

    @Test
    fun `mode Auto n'envoie rien si le poele ne chauffe pas`() {
        val (_, r) = call("POST", "/api/power", """{"power":"auto"}""")
        assertEquals(false, r.getBoolean("sent"))
        assertTrue(stove.writes.isEmpty())
        assertTrue(store.config.auto)
    }

    @Test
    fun `reglages du boitier`() {
        assertEquals("TESTCODE", call("GET", "/api/settings").second.getString("deviceCode"))
        assertEquals(400, call("PUT", "/api/settings", """{"relayHost":"a b","relayPort":3000,"deviceCode":"x"}""").first)
        val (s, r) = call("PUT", "/api/settings", """{"relayHost":"1.duepiwebserver1.com","relayPort":3000,"deviceCode":"ABC123"}""")
        assertEquals(200, s)
        assertEquals("ABC123", r.getString("deviceCode"))
    }

    @Test
    fun `consigne en attente envoyee des que le poele chauffe`() {
        call("POST", "/api/setpoint", """{"temperature":21}""")
        assertTrue(api.runPendingSetpoint())
        stove.heat()
        assertFalse(api.runPendingSetpoint())
        assertEquals("RF2150", stove.writes.last())
    }

    @Test
    fun `consigne en attente abandonnee apres une heure`() {
        call("POST", "/api/setpoint", """{"temperature":22}""")
        now = now.plusSeconds(3601)
        assertFalse(api.runPendingSetpoint())
        assertFalse(store.config.pendingSetpoint)
    }
}
