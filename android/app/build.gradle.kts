import java.util.Properties

plugins {
    alias(libs.plugins.android.application)
}

fun props(name: String) = Properties().apply {
    val f = rootProject.file(name)
    if (f.exists()) f.inputStream().use { load(it) }
}
val keystoreProps = props("keystore.properties")
val deviceProps = props("device.properties")
fun quoted(key: String) = "\"" + deviceProps.getProperty(key, "").replace("\"", "") + "\""

android {
    namespace = "app.mydpremote"
    compileSdk = 37

    defaultConfig {
        applicationId = "app.mydpremote"
        minSdk = 33
        targetSdk = 37
        versionCode = 4
        versionName = "1.3"
        // Valeurs par défaut du boîtier (modifiables dans Réglages).
        buildConfigField("String", "RELAY_HOST", quoted("relayHost"))
        buildConfigField("String", "RELAY_PORT", quoted("relayPort"))
        buildConfigField("String", "DEVICE_CODE", quoted("deviceCode"))
        // Dépôt GitHub qui garde les plages et les exécute (GitHub Actions).
        buildConfigField("String", "GITHUB_REPO", quoted("githubRepo"))
        buildConfigField("String", "GITHUB_TOKEN", quoted("githubToken"))
    }

    // L'interface web (dossier public/ du projet) est la seule source : elle est servie depuis les assets.
    sourceSets {
        getByName("main") {
            assets.directories.add("../../public")
        }
    }

    signingConfigs {
        create("release") {
            if (keystoreProps.isNotEmpty()) {
                storeFile = rootProject.file(keystoreProps.getProperty("storeFile"))
                storePassword = keystoreProps.getProperty("storePassword")
                keyAlias = keystoreProps.getProperty("keyAlias")
                keyPassword = keystoreProps.getProperty("keyPassword")
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            signingConfig = signingConfigs.getByName("release")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    buildFeatures {
        buildConfig = true
    }

    // android.util.Log ne fait rien dans les tests JVM.
    testOptions {
        unitTests.isReturnDefaultValues = true
    }
}

dependencies {
    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.work.runtime.ktx)
    implementation(libs.androidx.webkit)
    implementation(libs.kotlinx.coroutines.android)

    testImplementation(libs.junit)
    testImplementation(libs.json)
}
