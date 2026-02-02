# SeekerClaw ProGuard Rules

# Keep nodejs-mobile JNI bridge
-keep class io.niccolobocook.nodejsmobile.** { *; }

# Keep Kotlin coroutines
-keepnames class kotlinx.coroutines.** { *; }
