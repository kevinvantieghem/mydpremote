package app.mydpremote

import org.json.JSONArray
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

class SchedulerTest {
    private fun plage(id: String = "p", debut: String = "06:30", fin: String = "08:30") =
        Plage(id, id.uppercase(), debut, fin, List(7) { true }, true)

    private fun arr(vararg p: Plage) = Scheduler.toJson(p.toList())

    @Test
    fun `valide ce que l'interface envoie`() {
        assertEquals(listOf(plage()), Scheduler.validatePlages(arr(plage())))
        assertThrows(IllegalArgumentException::class.java) { Scheduler.validatePlages(arr(plage(debut = "25:00"))) }
        assertThrows(IllegalArgumentException::class.java) { Scheduler.validatePlages(arr(plage(fin = "06:30"))) }
        assertThrows(IllegalArgumentException::class.java) { Scheduler.validatePlages(arr(plage(), plage())) }
        assertThrows(IllegalArgumentException::class.java) { Scheduler.validatePlages(JSONArray("[{}]")) }
    }
}
