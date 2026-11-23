package com.atlas.audio

import android.content.Context
import android.media.AudioAttributes
import android.media.AudioDeviceInfo
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.os.Build
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class AtlasAudioRouteModule : Module() {
  @Volatile private var manager: AudioManager? = null
  @Volatile private var generation = 0L
  private var focus: AudioFocusRequest? = null
  private var previousMode = AudioManager.MODE_NORMAL
  private var changedMode = false
  private var selectedRoute = false
  private var removeListener: (() -> Unit)? = null

  @Synchronized
  private fun start(bluetooth: Boolean) {
    check(manager == null)
    check(Build.VERSION.SDK_INT >= 26)
    val activity = requireNotNull(appContext.currentActivity)
    val audio = activity.getSystemService(Context.AUDIO_SERVICE) as AudioManager
    // API 31 exposes a duplex communication route. Never claim A2DP playback is a headset mic.
    if (bluetooth) check(Build.VERSION.SDK_INT >= 31)
    val owner = ++generation
    val request = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT)
      .setAudioAttributes(AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION)
        .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build())
      .setOnAudioFocusChangeListener { change ->
        if (change < 0 && manager === audio && generation == owner) sendEvent("interruption")
      }.build()
    check(audio.requestAudioFocus(request) == AudioManager.AUDIOFOCUS_REQUEST_GRANTED)
    manager = audio
    focus = request
    try {
      previousMode = audio.mode
      audio.mode = AudioManager.MODE_IN_COMMUNICATION
      changedMode = true
      if (bluetooth && Build.VERSION.SDK_INT >= 31) {
        val device = audio.availableCommunicationDevices.firstOrNull {
          it.type == AudioDeviceInfo.TYPE_BLUETOOTH_SCO || it.type == AudioDeviceInfo.TYPE_BLE_HEADSET
        } ?: error("HEADSET_UNAVAILABLE")
        check(audio.setCommunicationDevice(device))
        selectedRoute = true
        val listener = AudioManager.OnCommunicationDeviceChangedListener { current ->
          if (manager === audio && generation == owner && current?.id != device.id) sendEvent("interruption")
        }
        audio.addOnCommunicationDeviceChangedListener(activity.mainExecutor, listener)
        removeListener = { audio.removeOnCommunicationDeviceChangedListener(listener) }
      }
    } catch (error: Exception) { stop(); throw error }
  }

  @Synchronized
  private fun stop() {
    val audio = manager ?: return
    manager = null
    try { removeListener?.invoke() } finally {
      removeListener = null
      try {
        if (selectedRoute && Build.VERSION.SDK_INT >= 31) audio.clearCommunicationDevice()
      } finally {
        selectedRoute = false
        try {
          if (changedMode && audio.mode == AudioManager.MODE_IN_COMMUNICATION) audio.mode = previousMode
        } finally {
          changedMode = false
          focus?.let { audio.abandonAudioFocusRequest(it) }
          focus = null
        }
      }
    }
  }

  override fun definition() = ModuleDefinition {
    Name("AtlasAudioRoute")
    Events("interruption")
    Function("start") { bluetooth: Boolean -> start(bluetooth) }
    Function("stop") { stop() }
    OnActivityEntersBackground {
      if (manager != null) { stop(); sendEvent("interruption") }
    }
    OnDestroy { stop() }
  }
}
