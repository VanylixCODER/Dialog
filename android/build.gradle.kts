plugins {
    id("com.android.application") version "8.7.3" apply false
    id("org.jetbrains.kotlin.android") version "1.9.24" apply false
    // Firebase Cloud Messaging (push). Requires app/google-services.json — kept out of the
    // repo (gitignored); CI writes it from the GOOGLE_SERVICES_JSON_B64 secret.
    id("com.google.gms.google-services") version "4.4.2" apply false
}
