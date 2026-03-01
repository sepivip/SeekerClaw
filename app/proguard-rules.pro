# SeekerClaw ProGuard Rules

# Keep nodejs-mobile JNI bridge
-keep class io.niccolobocook.nodejsmobile.** { *; }

# Keep NodeBridge native method (JNI entry point) — M-14
-keep class com.seekerclaw.app.service.NodeBridge {
    native <methods>;
    public *;
}

# Keep Kotlin coroutines
-keepnames class kotlinx.coroutines.** { *; }

# Strip debug/verbose logging in release builds — M-15
-assumenosideeffects class android.util.Log {
    public static int d(...);
    public static int v(...);
}
