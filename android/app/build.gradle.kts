plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "xyz.dialogmsg.app"
    compileSdk = 34

    defaultConfig {
        applicationId = "xyz.dialogmsg.app"
        minSdk = 24
        targetSdk = 34
        versionCode = 1
        versionName = "1.0.0"

        // The hosted web app the WebView loads — straight into the messenger
        // (/login), never the marketing landing page.
        buildConfigField("String", "APP_URL", "\"https://dialogmsg.xyz/login\"")
    }

    // Release signing — keystore details come from the environment (set by CI).
    // If no keystore is provided, assembleRelease produces an unsigned APK.
    val ksPath = System.getenv("DIALOG_KEYSTORE")
    signingConfigs {
        if (ksPath != null) {
            create("release") {
                storeFile = file(ksPath)
                storePassword = System.getenv("DIALOG_KS_PASS")
                keyAlias = System.getenv("DIALOG_KEY_ALIAS")
                keyPassword = System.getenv("DIALOG_KEY_PASS")
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro"
            )
            if (ksPath != null) {
                signingConfig = signingConfigs.getByName("release")
            }
        }
    }

    buildFeatures {
        buildConfig = true
        viewBinding = true
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("com.google.android.material:material:1.12.0")
    implementation("androidx.webkit:webkit:1.11.0")
    implementation("androidx.activity:activity-ktx:1.9.1")
    implementation("androidx.constraintlayout:constraintlayout:2.1.4")
}
