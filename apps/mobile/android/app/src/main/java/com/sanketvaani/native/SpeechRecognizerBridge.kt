package com.sanketvaani.native

import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer

/**
 * Live captions from the phone's speech recogniser.
 *
 * Designed for continuous listening:
 *  - Automatically continues listening across sentences until the user explicitly stops it.
 *  - Gracefully ignores silence pauses without crashing or disconnecting.
 *  - Prefers standard Google speech service to avoid OEM-specific disconnection crashes (code 11).
 *  - Never locks into an uninstalled offline pack.
 */
class SpeechRecognizerBridge(private val context: Context) {

  data class Snapshot(
    val isListening: Boolean,
    val partial: String,
    val finalText: String,
    val error: String?,
    val errorCode: Int?,
    val sessionId: Int,
  )

  private val lock = Any()
  private val main = Handler(Looper.getMainLooper())

  private var recognizer: SpeechRecognizer? = null
  private var isListening = false
  private var desiredListening = false
  private var partial = ""
  private var finalText = ""
  private var error: String? = null
  private var errorCode: Int? = null
  private var sessionId = 0
  private var language: String? = null
  private var onResultCallback: ((String) -> Unit)? = null
  private var cachedIntent: Intent? = null

  fun snapshot(): Snapshot =
    synchronized(lock) { Snapshot(isListening, partial, finalText, error, errorCode, sessionId) }

  fun isAvailable(): Boolean =
    try {
      SpeechRecognizer.isRecognitionAvailable(context)
    } catch (error: Exception) {
      false
    }

  fun isOnDeviceRecognitionAvailable(): Boolean? =
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) {
      null
    } else {
      try {
        SpeechRecognizer.isOnDeviceRecognitionAvailable(context)
      } catch (error: Exception) {
        null
      }
    }

  private fun createRecognizer(): SpeechRecognizer? {
    // 1. Try Google App voice recognition (most compatible across Android devices)
    val googleSearchComponent = ComponentName(
      "com.google.android.googlequicksearchbox",
      "com.google.android.voicesearch.serviceapi.GoogleRecognitionService"
    )
    try {
      val r = SpeechRecognizer.createSpeechRecognizer(context, googleSearchComponent)
      if (r != null) return r
    } catch (_: Exception) {}

    // 2. Try Google TTS recognition service
    val googleTtsComponent = ComponentName(
      "com.google.android.tts",
      "com.google.android.apps.speech.tts.googletts.service.GoogleTTSRecognitionService"
    )
    try {
      val r = SpeechRecognizer.createSpeechRecognizer(context, googleTtsComponent)
      if (r != null) return r
    } catch (_: Exception) {}

    // 3. Fallback to default system speech recognizer
    return try {
      SpeechRecognizer.createSpeechRecognizer(context)
    } catch (_: Exception) {
      null
    }
  }

  fun start(languageTag: String?, preferOffline: Boolean, onResult: (String) -> Unit) {
    main.post {
      teardown()

      desiredListening = true
      language = languageTag
      onResultCallback = onResult

      val fresh = createRecognizer()
      if (fresh == null) {
        setError("This device has no speech recognition service available.", null)
        return@post
      }

      recognizer = fresh

      synchronized(lock) {
        partial = ""
        finalText = ""
        error = null
        errorCode = null
        isListening = true
        sessionId += 1
      }

      val intent =
        Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
          putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
          putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true)
          // Only request offline if the platform explicitly confirms an on-device model exists
          if (preferOffline && isOnDeviceRecognitionAvailable() == true) {
            putExtra(RecognizerIntent.EXTRA_PREFER_OFFLINE, true)
          }
          putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 1)
          putExtra(RecognizerIntent.EXTRA_CALLING_PACKAGE, context.packageName)
          putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_COMPLETE_SILENCE_LENGTH_MILLIS, 3000L)
          putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_POSSIBLY_COMPLETE_SILENCE_LENGTH_MILLIS, 2000L)
          putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_MINIMUM_LENGTH_MILLIS, 1500L)
          if (!languageTag.isNullOrBlank()) {
            putExtra(RecognizerIntent.EXTRA_LANGUAGE, languageTag)
          }
        }
      cachedIntent = intent

      fresh.setRecognitionListener(createListener(fresh, intent, languageTag, onResult))

      try {
        fresh.startListening(intent)
      } catch (error: Exception) {
        setError("The speech recogniser could not start.", null)
      }
    }
  }

  private fun createListener(
    activeRecognizer: SpeechRecognizer,
    intent: Intent,
    languageTag: String?,
    onResult: (String) -> Unit
  ): RecognitionListener =
    object : RecognitionListener {
      override fun onReadyForSpeech(params: Bundle?) = Unit
      override fun onBeginningOfSpeech() = Unit
      override fun onRmsChanged(rmsdB: Float) = Unit
      override fun onBufferReceived(buffer: ByteArray?) = Unit
      override fun onEndOfSpeech() = Unit
      override fun onEvent(eventType: Int, params: Bundle?) = Unit

      override fun onPartialResults(partialResults: Bundle?) {
        val text = firstResult(partialResults) ?: return
        synchronized(lock) { partial = text }
      }

      override fun onResults(results: Bundle?) {
        val text = firstResult(results)
        synchronized(lock) {
          finalText = text ?: ""
          partial = ""
        }
        if (!finalText.isNullOrBlank()) {
          onResult(finalText)
        }

        // Seamless live continuous captioning: continue listening for the next phrase
        if (desiredListening) {
          main.postDelayed({
            if (desiredListening && recognizer === activeRecognizer) {
              try {
                activeRecognizer.startListening(intent)
              } catch (e: Exception) {
                // If restarting existing recognizer fails, recreate cleanly
                start(languageTag, preferOffline = false, onResult)
              }
            }
          }, 150)
        } else {
          synchronized(lock) { isListening = false }
        }
      }

      override fun onError(errorCode: Int) {
        // Transient errors that naturally occur during silence pauses or idle reconnects:
        // code 6: ERROR_SPEECH_TIMEOUT (no speech heard)
        // code 7: ERROR_NO_MATCH (silence or ambient sound)
        // code 8: ERROR_RECOGNIZER_BUSY (restarting too quickly)
        // code 11: ERROR_SERVER_DISCONNECTED (speech engine session refresh)
        // code 12, 13, 14: Language pack/model fallback
        val isTransient =
          errorCode == SpeechRecognizer.ERROR_SPEECH_TIMEOUT ||
          errorCode == SpeechRecognizer.ERROR_NO_MATCH ||
          errorCode == SpeechRecognizer.ERROR_RECOGNIZER_BUSY ||
          errorCode == 11 ||
          errorCode == 12 ||
          errorCode == 13 ||
          errorCode == 14

        if (desiredListening && isTransient) {
          main.postDelayed({
            if (desiredListening) {
              try {
                if (recognizer === activeRecognizer) {
                  activeRecognizer.startListening(intent)
                } else {
                  start(languageTag, preferOffline = false, onResult)
                }
              } catch (e: Exception) {
                start(languageTag, preferOffline = false, onResult)
              }
            }
          }, 250)
          return
        }

        synchronized(lock) {
          isListening = false
          desiredListening = false
          finalText = if (partial.isNotEmpty()) partial else ""
          partial = ""
          this@SpeechRecognizerBridge.error = describeError(errorCode)
          this@SpeechRecognizerBridge.errorCode = errorCode
        }
        onResult(finalText)
      }
    }

  fun stop() {
    main.post {
      desiredListening = false
      teardown()
    }
  }

  fun clear() {
    synchronized(lock) {
      partial = ""
      finalText = ""
      error = null
      errorCode = null
    }
  }

  private fun teardown() {
    val current = recognizer
    recognizer = null
    synchronized(lock) { isListening = false }
    if (current == null) return
    try {
      current.stopListening()
    } catch (_: Exception) {}
    try {
      current.cancel()
    } catch (_: Exception) {}
    try {
      current.destroy()
    } catch (_: Exception) {}
  }

  private fun setError(message: String, code: Int?) {
    synchronized(lock) {
      isListening = false
      desiredListening = false
      error = message
      errorCode = code
    }
  }

  private fun firstResult(bundle: Bundle?): String? {
    val list = bundle?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION) ?: return null
    return list.firstOrNull { it.isNotBlank() }
  }

  private fun describeError(code: Int): String =
    when (code) {
      SpeechRecognizer.ERROR_AUDIO -> "The microphone could not be read. Another app may be using it."
      SpeechRecognizer.ERROR_CLIENT -> "The recogniser stopped unexpectedly. Try again."
      SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS ->
        "Microphone permission is missing, so nothing could be heard."
      SpeechRecognizer.ERROR_NETWORK ->
        "The recogniser needed a network connection and could not reach one."
      SpeechRecognizer.ERROR_NETWORK_TIMEOUT -> "The recogniser timed out reaching the network."
      SpeechRecognizer.ERROR_NO_MATCH -> "Nothing was recognised in what was heard."
      SpeechRecognizer.ERROR_RECOGNIZER_BUSY ->
        "The recogniser is busy with another request. Try again in a moment."
      SpeechRecognizer.ERROR_SERVER -> "The recogniser's service reported an error."
      SpeechRecognizer.ERROR_SPEECH_TIMEOUT -> "No speech was heard."
      11 -> "Speech recognition connection was reset. Tap Start to resume."
      12 -> "This language is not supported for speech recognition on this device."
      13 -> "Offline speech model is not installed. Download voice data in device settings or connect to the internet."
      14 -> "Cannot check speech recognition language support on this device."
      else -> "The recogniser reported an error (code $code)."
    }
}
