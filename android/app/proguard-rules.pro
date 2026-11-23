# Le pont JavaScript est appelé par réflexion depuis la WebView.
-keepclassmembers class app.mydpremote.Bridge {
    @android.webkit.JavascriptInterface <methods>;
}
