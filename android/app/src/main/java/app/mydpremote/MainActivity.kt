package app.mydpremote

import android.annotation.SuppressLint
import android.app.Activity
import android.app.AlarmManager
import android.app.PendingIntent
import android.content.Intent
import android.graphics.Color
import android.os.Bundle
import android.view.WindowInsets
import android.webkit.JavascriptInterface
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import androidx.webkit.WebViewAssetLoader
import androidx.work.WorkManager
import org.json.JSONObject
import java.util.concurrent.Executors

class MainActivity : Activity() {
    private lateinit var web: WebView

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        cancelLegacySchedule()

        // L'interface (dossier public/) est servie depuis les assets, sous une adresse https locale.
        val loader = WebViewAssetLoader.Builder()
            .addPathHandler("/", WebViewAssetLoader.AssetsPathHandler(this))
            .build()

        web = WebView(this).apply {
            setBackgroundColor(Color.parseColor("#FFF8EE"))
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            settings.allowFileAccess = false
            addJavascriptInterface(Bridge(this@MainActivity, this), "Android")
            webViewClient = object : WebViewClient() {
                override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? =
                    loader.shouldInterceptRequest(request.url)

                override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                    if (request.url.host == ORIGIN_HOST) return false
                    startActivity(Intent(Intent.ACTION_VIEW, request.url))
                    return true
                }
            }
        }
        // Garde l'interface hors des barres système (heure, boutons de navigation).
        // La marge va sur un conteneur : une WebView ignore son propre padding pour la page.
        val root = FrameLayout(this).apply {
            setBackgroundColor(Color.parseColor("#FFF8EE"))
            addView(web, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT))
            setOnApplyWindowInsetsListener { v, insets ->
                val bars = insets.getInsets(WindowInsets.Type.systemBars() or WindowInsets.Type.ime())
                v.setPadding(bars.left, bars.top, bars.right, bars.bottom)
                WindowInsets.CONSUMED
            }
        }
        setContentView(root)
        if (savedInstanceState == null) web.loadUrl("https://$ORIGIN_HOST/index.html") else web.restoreState(savedInstanceState)
    }

    /** La version 1.1 déclenchait les plages sur le téléphone : on retire son alarme et son travail restants. */
    private fun cancelLegacySchedule() {
        val legacy = Intent().setClassName(packageName, "$packageName.AlarmReceiver")
        PendingIntent.getBroadcast(this, 0, legacy, PendingIntent.FLAG_NO_CREATE or PendingIntent.FLAG_IMMUTABLE)
            ?.let { getSystemService(AlarmManager::class.java).cancel(it) }
        WorkManager.getInstance(this).cancelUniqueWork("schedule")
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        web.saveState(outState)
    }

    override fun onDestroy() {
        web.destroy()
        super.onDestroy()
    }

    companion object {
        const val ORIGIN_HOST = WebViewAssetLoader.DEFAULT_DOMAIN
    }
}

/** Pont appelé par public/app.js : chaque appel part sur un fil d'arrière-plan, la réponse revient par __dpReply. */
class Bridge(private val activity: Activity, private val web: WebView) {
    private val executor = Executors.newCachedThreadPool()

    @JavascriptInterface
    fun call(id: Int, method: String, path: String, body: String?) {
        executor.execute {
            val reply = Graph.api(activity).handle(method, path, body)
            val js = "window.__dpReply($id, ${reply.status}, ${JSONObject.quote(reply.body)})"
            web.post { web.evaluateJavascript(js, null) }
        }
    }
}
