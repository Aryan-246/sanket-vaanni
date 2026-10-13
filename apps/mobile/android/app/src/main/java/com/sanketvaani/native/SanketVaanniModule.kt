package com.sanketvaani.native

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.os.Build
import android.os.Bundle
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.ReadableMap
import com.facebook.react.bridge.WritableMap
import java.util.Locale
import java.util.concurrent.atomic.AtomicInteger

/**
 * On-device text-to-speech and clipboard.
 *
 * ## Why this is written by hand rather than pulled in
 *
 * Both capabilities are single Android platform classes — `TextToSpeech` and
 * `ClipboardManager`. The published React Native wrappers for them are small
 * packages that would each add a native dependency, a build surface and a
 * maintenance obligation to get at roughly sixty lines of platform API. The
 * project budget is zero and the offline requirement is strict, so the platform
 * classes are used directly.
 *
 * ## Honesty rules this module enforces
 *
 *  - `isSpeaking` is driven by the platform's own
 *    `UtteranceProgressListener`, never by the fact that `speak` was called.
 *  - The resolved voice language is reported back to JavaScript, so the UI can
 *    say *which* language was actually spoken rather than which was requested.
 *    A device with no Hindi voice data must not be able to look like it is
 *    speaking Hindi.
 *  - Nothing here fabricates a completion. If the engine never calls back, the
 *    Promise is settled with an error by the JavaScript watchdog instead.
 */
class SanketVaanniModule(
  reactContext: ReactApplicationContext,
) : ReactContextBaseJavaModule(reactContext) {

  private var tts: TextToSpeech? = null
  private var initStatus: String = "initialising"

  /** Promises awaiting a completion callback, keyed by utterance id. */
  private val pending = HashMap<String, Promise>()
  private val utteranceCounter = AtomicInteger(0)
  private val lock = Any()

  init {
    tts =
      TextToSpeech(reactContext) { status ->
        synchronized(lock) {
          initStatus =
            when (status) {
              TextToSpeech.SUCCESS -> "ready"
              else -> "failed"
            }
          val engine = tts
          if (initStatus == "ready" && engine != null) {
            engine.setOnUtteranceProgressListener(
              object : UtteranceProgressListener() {
                override fun onStart(utteranceId: String?) = Unit

                override fun onDone(utteranceId: String?) {
                  settle(utteranceId, null)
                }

                @Deprecated("Superseded by onError(String, Int)")
                override fun onError(utteranceId: String?) {
                  settle(utteranceId, "The speech engine reported an error.")
                }

                override fun onError(utteranceId: String?, errorCode: Int) {
                  settle(utteranceId, "The speech engine reported error code $errorCode.")
                }
              },
            )
          }
        }
      }
  }

  override fun getName(): String = NAME

  /** Settles and removes the promise for an utterance, if one is still waiting. */
  private fun settle(utteranceId: String?, error: String?) {
    if (utteranceId == null) return
    val promise: Promise?
    synchronized(lock) {
      promise = pending.remove(utteranceId)
    }
    if (promise == null) return
    if (error == null) {
      promise.resolve(null)
    } else {
      promise.reject("E_TTS_SPEAK", error)
    }
  }

  /** The engine's own answer, not a guess made before asking it. */
  @ReactMethod
  fun isAvailable(promise: Promise) {
    promise.resolve(initStatus == "ready")
  }

  /**
   * Whether the engine has voice data for a BCP-47 tag, and what it would
   * actually use if asked to speak it.
   *
   * Returns `{ available, resolvedTag, engineDefaultTag }`. `available` is false
   * when the language has no installed voice, which is the truthful state on a
   * device that has never downloaded that language.
   */
  @ReactMethod
  fun isLanguageAvailable(tag: String, promise: Promise) {
    val engine = tts
    if (engine == null || initStatus != "ready") {
      promise.resolve(result(available = false, resolved = null, reason = "Engine not ready."))
      return
    }

    try {
      val locale = Locale.forLanguageTag(tag)
      val result = engine.isLanguageAvailable(locale)
      val available =
        result == TextToSpeech.LANG_AVAILABLE ||
          result == TextToSpeech.LANG_COUNTRY_AVAILABLE ||
          result == TextToSpeech.LANG_COUNTRY_VAR_AVAILABLE

      /*
       * `isLanguageAvailable` can report LANG_AVAILABLE for a language whose
       * *voice* still falls back, so the engine is also asked to set it. Only if
       * that assignment sticks is the language genuinely usable.
       */
      val assigned = engine.setLanguage(locale)
      val assignedOk =
        assigned != TextToSpeech.LANG_MISSING_DATA && assigned != TextToSpeech.LANG_NOT_SUPPORTED

      val map = Arguments.createMap()
      map.putBoolean("available", available && assignedOk)
      map.putString("resolvedTag", engine.voice?.locale?.toLanguageTag())
      map.putString("engineDefaultTag", Locale.getDefault().toLanguageTag())
      if (!(available && assignedOk)) {
        map.putString("reason", "No installed voice for $tag.")
      }
      promise.resolve(map)
    } catch (error: Exception) {
      promise.reject("E_TTS_LANGUAGE", error.message, error)
    }
  }

  /**
   * Speaks text. Resolves when the platform says the utterance finished.
   *
   * Options: `{ language?: string, rate?: number, pitch?: number, flush?: boolean }`.
   */
  @ReactMethod
  fun speak(text: String, options: ReadableMap?, promise: Promise) {
    val engine = tts
    if (engine == null || initStatus != "ready") {
      promise.reject("E_TTS_UNAVAILABLE", "The speech engine is not ready on this device.")
      return
    }
    if (text.isBlank()) {
      promise.reject("E_TTS_EMPTY", "There is nothing to speak.")
      return
    }

    val languageTag = if (options != null && options.hasKey("language")) {
      options.getString("language")
    } else {
      null
    }

    if (languageTag != null) {
      val locale = Locale.forLanguageTag(languageTag)
      val assigned = engine.setLanguage(locale)
      if (assigned == TextToSpeech.LANG_MISSING_DATA || assigned == TextToSpeech.LANG_NOT_SUPPORTED) {
        promise.reject(
          "E_TTS_LANGUAGE_UNAVAILABLE",
          "This device has no installed voice for $languageTag.",
        )
        return
      }
    }

    if (options != null && options.hasKey("rate")) {
      engine.setSpeechRate(options.getDouble("rate").toFloat())
    }
    if (options != null && options.hasKey("pitch")) {
      engine.setPitch(options.getDouble("pitch").toFloat())
    }

    val flush = options == null || !options.hasKey("flush") || options.getBoolean("flush")
    val utteranceId = "sv-${utteranceCounter.incrementAndGet()}"
    synchronized(lock) { pending[utteranceId] = promise }

    val params = Bundle()
    val mode = if (flush) TextToSpeech.QUEUE_FLUSH else TextToSpeech.QUEUE_ADD
    val queued = engine.speak(text, mode, params, utteranceId)

    if (queued != TextToSpeech.SUCCESS) {
      settle(utteranceId, "The speech engine refused the utterance.")
    }
  }

  /** Stops speech. Resolves whether or not anything was speaking. */
  @ReactMethod
  fun stop(promise: Promise) {
    val engine = tts
    var drained: List<Promise>
    synchronized(lock) {
      drained = pending.values.toList()
      pending.clear()
    }
    for (entry in drained) {
      entry.reject("E_TTS_STOPPED", "Speech was stopped.")
    }
    engine?.stop()
    promise.resolve(null)
  }

  /**
   * The identity of the build that is actually installed on this device.
   *
   * The version number is read from the package manager rather than from a
   * constant in JavaScript, because the repository holds three different
   * version strings — `package.json`, the Gradle `versionName`, and a value
   * that used to be written into the Settings screen by hand. Only one of them
   * describes the running app, and it is this one. Reporting anything else
   * means the About screen can disagree with the APK that is on the phone.
   */
  @ReactMethod
  fun getBuildInfo(promise: Promise) {
    try {
      val context = reactApplicationContext
      val info = context.packageManager.getPackageInfo(context.packageName, 0)
      val result: WritableMap = Arguments.createMap()
      result.putString("packageName", context.packageName)
      result.putString("versionName", info.versionName ?: "unknown")
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
        result.putDouble("versionCode", info.longVersionCode.toDouble())
      } else {
        @Suppress("DEPRECATION")
        result.putDouble("versionCode", info.versionCode.toDouble())
      }
      result.putString("androidRelease", Build.VERSION.RELEASE ?: "unknown")
      result.putInt("androidSdk", Build.VERSION.SDK_INT)
      result.putString("manufacturer", Build.MANUFACTURER ?: "unknown")
      result.putString("model", Build.MODEL ?: "unknown")
      promise.resolve(result)
    } catch (error: Exception) {
      promise.reject("E_BUILD_INFO", error.message, error)
    }
  }

  /** True while the platform reports an utterance in progress. */
  @ReactMethod
  fun isSpeaking(promise: Promise) {
    promise.resolve(tts?.isSpeaking ?: false)
  }

  /* ---------------------------------------------------------- captions */

  /** The recogniser bridge, created on first use. */
  private val recognition: SpeechRecognizerBridge by lazy {
    SpeechRecognizerBridge(reactApplicationContext)
  }

  @ReactMethod
  fun isRecognitionAvailable(promise: Promise) {
    promise.resolve(recognition.isAvailable())
  }

  /** `null` when the platform cannot answer. True/false otherwise. */
  @ReactMethod
  fun hasOnDeviceRecognition(promise: Promise) {
    promise.resolve(recognition.isOnDeviceRecognitionAvailable())
  }

  /**
   * Opens the microphone. Resolves immediately.
   *
   * Deliberately not a promise that resolves on the final transcript: captions
   * appear while the user is still speaking, so the caller needs the session to
   * be observable, not awaited. Results are read with [getTranscript].
   */
  @ReactMethod
  fun startRecognition(languageTag: String?, preferOffline: Boolean, promise: Promise) {
    if (!recognition.isAvailable()) {
      promise.reject("E_NO_RECOGNISER", "This device has no speech recognition service.")
      return
    }
    try {
      recognition.start(languageTag, preferOffline) { /* final text read by polling */ }
      promise.resolve(null)
    } catch (error: Exception) {
      promise.reject("E_RECOGNISER_START", error.message, error)
    }
  }

  @ReactMethod
  fun stopRecognition(promise: Promise) {
    recognition.stop()
    promise.resolve(null)
  }

  @ReactMethod
  fun getTranscript(promise: Promise) {
    val snapshot = recognition.snapshot()
    val result: WritableMap = Arguments.createMap()
    result.putBoolean("isListening", snapshot.isListening)
    result.putString("partial", snapshot.partial)
    result.putString("finalText", snapshot.finalText)
    result.putString("error", snapshot.error)
    if (snapshot.errorCode == null) {
      result.putNull("errorCode")
    } else {
      result.putInt("errorCode", snapshot.errorCode)
    }
    result.putInt("sessionId", snapshot.sessionId)
    promise.resolve(result)
  }

  @ReactMethod
  fun clearTranscript(promise: Promise) {
    recognition.clear()
    promise.resolve(null)
  }

  @ReactMethod
  fun setClipboard(text: String, promise: Promise) {
    try {
      val manager =
        reactApplicationContext.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
      manager.setPrimaryClip(ClipData.newPlainText(CLIP_LABEL, text))
      promise.resolve(true)
    } catch (error: Exception) {
      promise.reject("E_CLIPBOARD_SET", error.message, error)
    }
  }

  /** Returns the current clip, or null when it holds nothing text-like. */
  @ReactMethod
  fun getClipboard(promise: Promise) {
    try {
      val manager =
        reactApplicationContext.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
      val clip = manager.primaryClip
      val text =
        if (clip != null && clip.itemCount > 0) clip.getItemAt(0).coerceToText(reactApplicationContext)?.toString() else null
      if (text == null) promise.resolve(null) else promise.resolve(text)
    } catch (error: Exception) {
      // Some Android versions refuse clipboard reads when the app is not in
      // focus. That is a normal outcome, not a failure worth rejecting on.
      promise.resolve(null)
    }
  }

  private fun result(available: Boolean, resolved: String?, reason: String?): WritableMap {
    val map = Arguments.createMap()
    map.putBoolean("available", available)
    map.putString("resolvedTag", resolved)
    if (reason != null) map.putString("reason", reason)
    return map
  }

  override fun invalidate() {
    synchronized(lock) {
      val outstanding = pending.values.toList()
      pending.clear()
      for (entry in outstanding) {
        entry.reject("E_TTS_DISPOSED", "The module was disposed before speech finished.")
      }
    }
    tts?.stop()
    tts?.shutdown()
    tts = null
    super.invalidate()
  }

  companion object {
    const val NAME = "SanketVaanniNative"
    private const val CLIP_LABEL = "Sanket Vaanni"
  }
}
