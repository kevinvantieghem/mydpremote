plugins {
    alias(libs.plugins.android.application) apply false
    // Puts Kotlin on the classpath for AGP's built-in Kotlin support.
    alias(libs.plugins.kotlin.android) apply false
}
