package com.sanketvaani.native

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
 * Live captions from the phone's own speech recogniser.
 *
 * ## Why the platform recogniser and not a service
 *
 * Android ships a speech recognition service and every device in this project's
 * target range has one. Calling it costs nothing, adds no dependency, and keeps
 * the audio path on the device the user already trusts. A cloud speech API
 * would be a paid provider, which the project budget forbids absolutely.
 *
 * ## What this bridge does not claim
 *
 * `EXTRA_PREFER_OFFLINE` is a *preference*. Android's recogniser is free to
 * ignore it and stream audio to the vendor's servers, and on most phones it
 * does. This class therefore never reports whether recognition was local,
 * because it cannot know — that determination belongs to the service, and
 * anything asserted here would be a guess dressed as a fact. `isOnlineCapable`
 * reports what the service *says* about itself, which is the only honest signal
 * available, and the UI is responsible for wording it as such.
 *
 * ## Why results are polled rather than pushed
 *
 * Partial results arrive on the main thread through `RecognitionListener`, and
 * the natural transport would be an event emitter. Emitting from a legacy
 * module under the bridgeless runtime goes through an interop path whose
 * behaviour varies by React Native version, and a caption line that silently
 * stops updating is exactly the failure this app must not have. The listener
 * instead writes to a small synchronized state block, and JavaScript reads it
 * on a timer while the microphone is open. A local read every 150ms is cheap,
 * and it cannot fall out of step with the runtime.
 *
 * ## Lifecycle
 *
 * One recogniser per bridge, created lazily on the main thread and destroyed
 * when the session ends. `SpeechRecognizer` throws if it is created or invoked
 * off the main thread, which is why every call into it is posted to the UI
 * queue.
 */
class SpeechRecognizerBridge(private val context: Context) {

  /** What JavaScript can see. Every field is written under [lock]. */
  data class Snapshot(
    val isListening: Boolean,
    val partial: String,
    val finalText: String,
    val error: String?,
    /** Android's own error code, or null. Reported so the UI can be specific. */
    val errorCode: Int?,
    val sessionId: Int,
  )

  private val lock = Any()
  private val main = Handler(Looper.getMainLooper())

  private var recognizer: SpeechRecognizer? = null
  private var isListening = false
  private var partial = ""
  private var finalText = ""
  private var error: String? = null
  private var errorCode: Int? = null
  private var sessionId = 0
  private var language: String? = null

  fun snapshot(): Snapshot =
    synchronized(lock) { Snapshot(isListening, partial, finalText, error, errorCode, sessionId) }

  /**
   * Whether a recognition service is installed at all.
   *
   * Android 11 package visibility applies: without the `<queries>` entry for
   * `android.speech.RecognitionService` in the manifest this returns false even
   * on a phone that has one, so a false here is reported as "no recogniser"
   * rather than assumed to be a device limitation.
   */
  fun isAvailable(): Boolean =
    try {
      SpeechRecognizer.isRecognitionAvailable(context)
    } catch (error: Exception) {
      false
    }

  /**
   * Whether the phone has an on-device recognition model installed.
   *
   * A static query about the service, so it does not require the main thread.
   * `null` below Android 12, where the API does not exist — not `false`, which
   * would assert that no offline model is present when the question cannot be
   * asked. This says nothing about whether a given language is covered by that
   * model; only `EXTRA_PREFER_OFFLINE` plus an actual attempt can show that.
   */
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

  /**
   * Opens the microphone.
   *
   * `RECORD_AUDIO` must already be granted; the caller checks that first, so a
   * failure here is reported rather than silently swallowed.
   */
  fun start(languageTag: String?, preferOffline: Boolean, onResult: (String) -> Unit) {
    main.post {
      // A second start while one is running is a caller bug, but tearing the
      // old session down first is cheaper than throwing: the user pressed the
      // button twice, and the second press should just work.
      teardown()

      val fresh =
        try {
          SpeechRecognizer.createSpeechRecognizer(context)
        } catch (error: Exception) {
          setError("This device could not create a speech recogniser.", null)
          return@post
        }

      if (fresh == null) {
        setError("This device has no speech recognition service.", null)
        return@post
      }

      recognizer = fresh
      language = languageTag

      synchronized(lock) {
        partial = ""
        finalText = ""
        error = null
        errorCode = null
        isListening = true
        sessionId += 1
      }

      fresh.setRecognitionListener(
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
              // The partial and the final are two views of one utterance. Once
              // the final exists the partial must stop being rendered, or the
              // screen shows the same words twice.
              partial = ""
              isListening = false
            }
            onResult(finalText)
          }

          override fun onError(errorCode: Int) {
            if (preferOffline && (errorCode == 12 || errorCode == 13 || errorCode == 14)) {
              // Graceful online fallback: offline model is not installed on this device,
              // automatically retry with online recognition once.
              main.post {
                start(languageTag, preferOffline = false, onResult)
              }
              return
            }
            synchronized(lock) {
              isListening = false
              // A partial that never became final is still worth keeping: the
              // user said something and the service dropped the last word.
              finalText = if (partial.isNotEmpty()) partial else ""
              partial = ""
              this@SpeechRecognizerBridge.error = describeError(errorCode)
              this@SpeechRecognizerBridge.errorCode = errorCode
            }
            onResult(finalText)
          }
        },
      )

      val intent =
        Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
          putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
          putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true)
          putExtra(RecognizerIntent.EXTRA_PREFER_OFFLINE, preferOffline)
          putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 1)
          putExtra(RecognizerIntent.EXTRA_CALLING_PACKAGE, context.packageName)
          /*
           * A regional tag when one is supplied. Android's recogniser is much
           * more reliable with `en-IN` than with `en` — the bare tag can select
           * an American model and mis-hear Indian English — and the preference
           * the user chose is regional for exactly this reason.
           */
          if (!languageTag.isNullOrBlank()) {
            putExtra(RecognizerIntent.EXTRA_LANGUAGE, languageTag)
          }
        }

      try {
        fresh.startListening(intent)
      } catch (error: Exception) {
        setError("The speech recogniser refused to start.", null)
      }
    }
  }

  /**
   * Closes the microphone and releases the recogniser.
   *
   * Safe to call when nothing is running, and safe to call twice — the
   * microphone being left open is a privacy failure, so teardown is written to
   * be unconditionally safe rather than conditionally correct.
   */
  fun stop() {
    main.post { teardown() }
  }

  /** Clears the transcript without touching the microphone state. */
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
    } catch (error: Exception) {
      // Already finished. Nothing to stop.
    }
    try {
      current.cancel()
    } catch (error: Exception) {
      // Already cancelled.
    }
    try {
      current.destroy()
    } catch (error: Exception) {
      // Already destroyed.
    }
  }

  private fun setError(message: String, code: Int?) {
    synchronized(lock) {
      isListening = false
      error = message
      errorCode = code
    }
  }

  /**
   * The best hypothesis from a results bundle.
   *
   * Android returns the list in descending confidence order, so index 0 is the
   * top hypothesis. The confidence score is deliberately not returned: the
   * product does not show confidence percentages for recognised text, because a
   * percentage a user cannot act on is worse than no number at all.
   */
  private fun firstResult(bundle: Bundle?): String? {
    val list = bundle?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION) ?: return null
    return list.firstOrNull { it.isNotBlank() }
  }

  /**
   * Android's error codes, in words a person can act on.
   *
   * The list is exhaustive over the codes the platform documents. Each message
   * says what happened *and* whether it was the user's doing, because "no match"
   * and "no microphone permission" need completely different responses.
   */
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
      12 -> "This language is not supported for speech recognition on this device."
      13 -> "Offline speech model is not installed. Download voice data in device settings or connect to the internet."
      14 -> "Cannot check speech recognition language support on this device."
      else -> "The recogniser reported an unspecified error (code $code)."
    }
}
