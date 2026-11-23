// Point d'accès à la logique, et vérification en arrière-plan de la consigne après un allumage manuel.
// Les plages ne sont plus déclenchées par le téléphone : c'est GitHub Actions qui s'en charge (scripts/tick.ts).

package app.mydpremote

import android.content.Context
import androidx.work.Constraints
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.Worker
import androidx.work.WorkerParameters
import java.util.concurrent.TimeUnit

/** Point d'accès unique à la logique, partagé par l'interface et le travail en arrière-plan. */
object Graph {
    @Volatile private var api: Api? = null

    fun api(context: Context): Api = api ?: synchronized(this) {
        api ?: run {
            val app = context.applicationContext
            val store = Store(
                PrefsKeyValue(app),
                Device(BuildConfig.RELAY_HOST, BuildConfig.RELAY_PORT.toIntOrNull() ?: 3000, BuildConfig.DEVICE_CODE),
            )
            Api(store, AndroidHooks(app), GitHubCloud(BuildConfig.GITHUB_REPO, BuildConfig.GITHUB_TOKEN))
        }.also { api = it }
    }
}

class AndroidHooks(private val context: Context) : Hooks {
    override fun setpointPending() {
        WorkManager.getInstance(context).enqueueUniqueWork("setpoint", ExistingWorkPolicy.REPLACE, SetpointWorker.request())
    }
}

/** Revérifie toutes les 3 minutes (pendant 1 h au plus) pour envoyer la consigne dès que le poêle chauffe. */
class SetpointWorker(context: Context, params: WorkerParameters) : Worker(context, params) {
    override fun doWork(): Result {
        if (Graph.api(applicationContext).runPendingSetpoint()) {
            WorkManager.getInstance(applicationContext)
                .enqueueUniqueWork("setpoint", ExistingWorkPolicy.APPEND_OR_REPLACE, request())
        }
        return Result.success()
    }

    companion object {
        fun request() = OneTimeWorkRequestBuilder<SetpointWorker>()
            .setInitialDelay(3, TimeUnit.MINUTES)
            .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
            .build()
    }
}
