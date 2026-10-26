package com.sanketvaani.native

import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.speech.RecognitionListener
import android.speech.RecognitionService
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import android.util.Log

/**
 * Live captions from the phone's speech recogniser.
 *
 * Designed for continuous, robust listening:
 *  - Dynamically targets verified RecognitionService on the device (e.g. Google TTS / Speech Services).
 *  - Automatically continues listening across sentences with gentle spacing.
 *  - Handles silence pauses with bounded retries to prevent rate limiting (code 10).
 *  - Prevents rapid cyclic reconnects on broken binders (code 11).
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
    try {
      // 1. Query all installed RecognitionService components on this device
      val queryIntent = Intent(RecognitionService.SERVICE_INTERFACE)
      val availableServices = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
        context.packageManager.queryIntentServices(
          queryIntent,
          PackageManager.ResolveInfoFlags.of(0)
        )
      } else {
        context.packageManager.queryIntentServices(queryIntent, 0)
      }

      // Check for Google Speech Recognition & Synthesis service (com.google.android.tts)
      val ttsService = availableServices.firstOrNull {
        it.serviceInfo?.packageName == "com.google.android.tts"
      }
      if (ttsService != null) {
        val component = ComponentName(ttsService.serviceInfo.packageName, ttsService.serviceInfo.name)
        val r = SpeechRecognizer.createSpeechRecognizer(context, component)
        if (r != null) {
          Log.i("SpeechBridge", "Selected Google TTS speech recognizer: $component")
          return r
        }
      }

      // 2. Check system secure default voice_recognition_service setting
      val defaultSetting = Settings.Secure.getString(context.contentResolver, "voice_recognition_service")
      if (!defaultSetting.isNullOrBlank()) {
        val defaultComponent = ComponentName.unflattenFromString(defaultSetting)
        if (defaultComponent != null) {
          val r = SpeechRecognizer.createSpeechRecognizer(context, defaultComponent)
          if (r != null) {
            Log.i("SpeechBridge", "Selected default voice service: $defaultComponent")
            return r
          }
        }
      }
    } catch (e: Exception) {
      Log.w("SpeechBridge", "Exception checking specific speech services", e)
    }

    // 3. Fallback to standard platform SpeechRecognizer
    return try {
      Log.i("SpeechBridge", "Falling back to standard SpeechRecognizer.createSpeechRecognizer")
      SpeechRecognizer.createSpeechRecognizer(context)
    } catch (e: Exception) {
      Log.e("SpeechBridge", "Failed to create SpeechRecognizer", e)
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
          putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 1)
          putExtra(RecognizerIntent.EXTRA_CALLING_PACKAGE, context.packageName)
          if (!languageTag.isNullOrBlank()) {
            putExtra(RecognizerIntent.EXTRA_LANGUAGE, languageTag)
          }
        }
      cachedIntent = intent

      fresh.setRecognitionListener(createListener(fresh, intent, languageTag, onResult))

      try {
        Log.i("SpeechBridge", "Starting speech recognition listening...")
        fresh.startListening(intent)
      } catch (error: Exception) {
        Log.e("SpeechBridge", "fresh.startListening threw exception", error)
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
      private var silenceRetries = 0

      override fun onReadyForSpeech(params: Bundle?) {
        Log.d("SpeechBridge", "onReadyForSpeech")
      }
      override fun onBeginningOfSpeech() {
        Log.d("SpeechBridge", "onBeginningOfSpeech")
        silenceRetries = 0
      }
      override fun onRmsChanged(rmsdB: Float) = Unit
      override fun onBufferReceived(buffer: ByteArray?) = Unit
      override fun onEndOfSpeech() {
        Log.d("SpeechBridge", "onEndOfSpeech")
      }
      override fun onEvent(eventType: Int, params: Bundle?) = Unit

      override fun onPartialResults(partialResults: Bundle?) {
        val text = firstResult(partialResults) ?: return
        synchronized(lock) { partial = text }
      }

      override fun onResults(results: Bundle?) {
        val text = firstResult(results)
        Log.d("SpeechBridge", "onResults: $text")
        silenceRetries = 0

        synchronized(lock) {
          finalText = text ?: ""
          partial = ""
        }
        if (!finalText.isNullOrBlank()) {
          onResult(finalText)
        }

        // Continuous captioning: pause briefly before listening for next sentence
        if (desiredListening) {
          main.postDelayed({
            if (desiredListening && recognizer === activeRecognizer) {
              try {
                activeRecognizer.startListening(intent)
              } catch (e: Exception) {
                Log.w("SpeechBridge", "Restarting listener on results failed", e)
                synchronized(lock) { isListening = false }
              }
            }
          }, 400)
        } else {
          synchronized(lock) { isListening = false }
        }
      }

      override fun onError(errorCode: Int) {
        Log.w("SpeechBridge", "onError: $errorCode (${describeError(errorCode)})")

        // Handle silence timeouts (code 6) and no-match (code 7) during active continuous listening
        val isSilencePause =
          errorCode == SpeechRecognizer.ERROR_SPEECH_TIMEOUT ||
          errorCode == SpeechRecognizer.ERROR_NO_MATCH

        if (desiredListening && isSilencePause && silenceRetries < 4) {
          silenceRetries++
          Log.i("SpeechBridge", "Silence/pause detected, softly resuming listening (retry $silenceRetries/4)...")
          main.postDelayed({
            if (desiredListening && recognizer === activeRecognizer) {
              try {
                activeRecognizer.startListening(intent)
              } catch (e: Exception) {
                Log.w("SpeechBridge", "Retry after silence failed", e)
              }
            }
          }, 600)
          return
        }

        // For all other errors, or once silence retries are exhausted, cleanly stop and report
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
      10 -> "Too many speech requests. Please wait a moment and tap Start."
      11 -> "Speech recognition connection was reset. Tap Start to resume."
      12 -> "This language is not supported for speech recognition on this device."
      13 -> "Offline speech model is not installed. Download voice data in device settings or connect to the internet."
      14 -> "Cannot check speech recognition language support on this device."
      else -> "The recogniser reported an error (code $code)."
    }
}
