# 当前 minifyEnabled=false，这里只是预留：一旦开启混淆，OkHttp/Okio 需要这些规则。
-dontwarn okhttp3.**
-dontwarn okio.**
-dontwarn org.conscrypt.**
-dontwarn org.bouncycastle.**
-dontwarn org.openjsse.**

-keep class ai.deepseek.tablet.** { *; }
-keepclassmembers class * extends android.app.Activity {
    public void *(android.view.View);
}

# OkHttp 平台探测相关（关闭混淆时无效，开启后必需）
-keepnames class okhttp3.internal.platform.Platform
-keepnames class okhttp3.internal.platform.android.AndroidPlatform
-dontwarn javax.annotation.**
