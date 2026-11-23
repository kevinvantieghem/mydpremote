package app.mydpremote

import org.junit.Assume.assumeTrue
import org.junit.Test

/**
 * Lecture seule du vrai poêle (aucune écriture). Ne tourne que si DP_CODE est défini :
 *   DP_CODE=... DP_HOST=1.duepiwebserver1.com DP_PORT=3000 ./gradlew testDebugUnitTest --tests '*RealStoveProbe*'
 */
class RealStoveProbeTest {
    @Test
    fun `lecture seule du vrai poele`() {
        val code = System.getenv("DP_CODE")
        assumeTrue(!code.isNullOrBlank())
        val host = System.getenv("DP_HOST") ?: "1.duepiwebserver1.com"
        val port = System.getenv("DP_PORT")?.toInt() ?: 3000
        val status = Stove.readStatus(RelayOptions(code!!) { SocketTransport(host, port) })
        println("PROBE " + status.toString(2))
    }
}
