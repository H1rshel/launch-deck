import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// OneDrive locks build intermediates; when the repo lives under OneDrive,
// point LD_REMOTE_BUILD_DIR at a local path (e.g. C:\Dev\ld-build\remote).
System.getenv("LD_REMOTE_BUILD_DIR")?.let {
    layout.buildDirectory.set(File(it))
}

// Release signing: keystore lives OUTSIDE the repo (never committed).
val keystoreProperties = Properties().apply {
    val propFile = file(System.getProperty("user.home") + "/.android-keys/keystore.properties")
    if (propFile.exists()) {
        propFile.inputStream().use { load(it) }
    }
}

android {
    compileSdk = 36
    namespace = "com.launchdeck.remote"

    defaultConfig {
        applicationId = "com.launchdeck.remote"
        minSdk = 24
        targetSdk = 36
        versionCode = 2002
        versionName = "2.0.2"
        // Consume the nonRoot flavor of the moonlight engine module
        missingDimensionStrategy("root", "nonRoot")
        ndk {
            abiFilters += listOf("arm64-v8a")
        }
    }

    signingConfigs {
        if (keystoreProperties.containsKey("storeFile")) {
            create("release") {
                storeFile = file(keystoreProperties.getProperty("storeFile"))
                storePassword = keystoreProperties.getProperty("storePassword")
                keyAlias = keystoreProperties.getProperty("keyAlias")
                keyPassword = keystoreProperties.getProperty("keyPassword")
            }
        }
    }

    buildTypes {
        getByName("release") {
            if (keystoreProperties.containsKey("storeFile")) {
                signingConfig = signingConfigs.getByName("release")
            }
            isMinifyEnabled = false
        }
    }

    buildFeatures {
        buildConfig = true
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_11
        targetCompatibility = JavaVersion.VERSION_11
    }
    kotlinOptions {
        jvmTarget = "11"
    }
}

dependencies {
    // The streaming engine (GPL-3; source: github.com/H1rshel/moonlight-android)
    implementation(project(":moonlight"))
    implementation("androidx.webkit:webkit:1.14.0")
    implementation("androidx.appcompat:appcompat:1.7.1")
    implementation("androidx.core:core-ktx:1.15.0")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.8.1")
}
