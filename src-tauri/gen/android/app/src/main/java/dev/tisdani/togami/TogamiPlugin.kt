// The commands src-tauri/src/android.rs calls: the app in front and pushing
// it away (BlockService), the two permissions, now playing (media sessions,
// allowed by MediaListener), the auto-updater (Updater.kt), opening a link,
// going to the background, and
// the colour behind the status and navigation bars.

package dev.tisdani.togami

import android.app.Activity
import android.content.ComponentName
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Color
import android.media.MediaMetadata
import android.media.session.MediaController
import android.media.session.MediaSessionManager
import android.media.session.PlaybackState
import android.net.Uri
import android.os.Build
import android.os.SystemClock
import android.provider.Settings
import android.util.Base64
import androidx.core.app.NotificationManagerCompat
import androidx.core.view.WindowCompat
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import java.io.ByteArrayOutputStream

@InvokeArg
class PushArgs {
  var kind: String = "app"
}

@InvokeArg
class ActionArgs {
  var action: String = ""
}

@InvokeArg
class UrlArgs {
  var url: String = ""
}

@InvokeArg
class BarsArgs {
  var color: String = "#fbfbfa"
  var dark: Boolean = false
}

@TauriPlugin
class TogamiPlugin(private val activity: Activity) : Plugin(activity) {
  private var artKey: String? = null
  private var art: String? = null

  @Command
  fun foreground(invoke: Invoke) {
    val out = JSObject()
    BlockService.instance?.front()?.let { out.put("front", it) }
    invoke.resolve(out)
  }

  @Command
  fun pushAway(invoke: Invoke) {
    invoke.parseArgs(PushArgs::class.java)
    BlockService.instance?.pushAway()
    invoke.resolve()
  }

  private fun flag(on: Boolean): JSObject = JSObject().apply { put("on", on) }

  @Command
  fun accessStatus(invoke: Invoke) {
    invoke.resolve(flag(BlockService.instance != null))
  }

  /** Accessibility settings, with Togami's entry highlighted where Android supports it. */
  @Command
  fun accessRequest(invoke: Invoke) {
    val component = ComponentName(activity, BlockService::class.java).flattenToString()
    val intent = Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS)
      .putExtra(":settings:fragment_args_key", component)
      .putExtra(":settings:show_fragment_args", android.os.Bundle().apply { putString(":settings:fragment_args_key", component) })
    open(intent)
    invoke.resolve()
  }

  @Command
  fun listenerStatus(invoke: Invoke) {
    invoke.resolve(flag(NotificationManagerCompat.getEnabledListenerPackages(activity).contains(activity.packageName)))
  }

  @Command
  fun listenerRequest(invoke: Invoke) {
    val component = ComponentName(activity, MediaListener::class.java)
    val intent = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
      Intent(Settings.ACTION_NOTIFICATION_LISTENER_DETAIL_SETTINGS)
        .putExtra(Settings.EXTRA_NOTIFICATION_LISTENER_COMPONENT_NAME, component.flattenToString())
    } else {
      Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS)
    }
    if (!open(intent)) open(Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS))
    invoke.resolve()
  }

  /** Togami's App info page (where "Allow restricted settings" is, in the ⋮ menu). */
  @Command
  fun appInfo(invoke: Invoke) {
    open(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:${activity.packageName}")))
    invoke.resolve()
  }

  private fun open(intent: Intent): Boolean = try {
    activity.startActivity(intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    true
  } catch (_: Exception) {
    false
  }

  // ---------- now playing ----------

  private fun controllers(): List<MediaController> = try {
    val msm = activity.getSystemService(MediaSessionManager::class.java)
    msm.getActiveSessions(ComponentName(activity, MediaListener::class.java))
  } catch (_: Exception) {
    emptyList() // notification access isn't allowed
  }

  /** The playing session, else the first one with a track. */
  private fun current(): MediaController? {
    val all = controllers().filter { it.metadata != null }
    return all.firstOrNull { it.playbackState?.state == PlaybackState.STATE_PLAYING } ?: all.firstOrNull()
  }

  @Command
  fun mediaNow(invoke: Invoke) {
    val out = JSObject()
    val c = current()
    val meta = c?.metadata
    if (c != null && meta != null) {
      val title = meta.getString(MediaMetadata.METADATA_KEY_TITLE) ?: meta.getString(MediaMetadata.METADATA_KEY_DISPLAY_TITLE) ?: ""
      val artist = meta.getString(MediaMetadata.METADATA_KEY_ARTIST) ?: meta.getString(MediaMetadata.METADATA_KEY_ALBUM_ARTIST) ?: meta.getString(MediaMetadata.METADATA_KEY_DISPLAY_SUBTITLE) ?: ""
      if (title.isNotEmpty()) {
        val state = c.playbackState
        val playing = state?.state == PlaybackState.STATE_PLAYING
        var position = state?.position ?: 0L
        if (playing && state != null && state.lastPositionUpdateTime > 0) {
          position += ((SystemClock.elapsedRealtime() - state.lastPositionUpdateTime) * state.playbackSpeed).toLong()
        }
        val duration = meta.getLong(MediaMetadata.METADATA_KEY_DURATION).coerceAtLeast(0)
        val source = try {
          val pm = activity.packageManager
          pm.getApplicationLabel(pm.getApplicationInfo(c.packageName, 0)).toString()
        } catch (_: Exception) {
          c.packageName
        }
        val m = JSObject()
        m.put("title", title)
        m.put("artist", artist)
        m.put("source", source)
        m.put("playing", playing)
        m.put("positionMs", position.coerceIn(0L, if (duration > 0) duration else Long.MAX_VALUE))
        m.put("durationMs", duration)
        artFor("$title\u0001$artist", meta)?.let { m.put("art", it) }
        out.put("media", m)
      }
    }
    invoke.resolve(out)
  }

  /** Album art as a small JPEG data URL, re-encoded only when the track changes. */
  private fun artFor(key: String, meta: MediaMetadata): String? {
    if (key == artKey) return art
    artKey = key
    art = null
    val bmp = meta.getBitmap(MediaMetadata.METADATA_KEY_ALBUM_ART) ?: meta.getBitmap(MediaMetadata.METADATA_KEY_ART) ?: meta.getBitmap(MediaMetadata.METADATA_KEY_DISPLAY_ICON) ?: return null
    return try {
      val side = 160
      val scaled = if (bmp.width > side || bmp.height > side) Bitmap.createScaledBitmap(bmp, side, side * bmp.height / bmp.width.coerceAtLeast(1), true) else bmp
      val bytes = ByteArrayOutputStream()
      scaled.compress(Bitmap.CompressFormat.JPEG, 82, bytes)
      art = "data:image/jpeg;base64," + Base64.encodeToString(bytes.toByteArray(), Base64.NO_WRAP)
      art
    } catch (_: Exception) {
      null
    }
  }

  @Command
  fun mediaControl(invoke: Invoke) {
    val args = invoke.parseArgs(ActionArgs::class.java)
    current()?.transportControls?.let { t ->
      when (args.action) {
        "toggle" -> if (current()?.playbackState?.state == PlaybackState.STATE_PLAYING) t.pause() else t.play()
        "next" -> t.skipToNext()
        "previous" -> t.skipToPrevious()
      }
    }
    invoke.resolve()
  }

  // ---------- the rest ----------

  @Command
  fun openUrl(invoke: Invoke) {
    val args = invoke.parseArgs(UrlArgs::class.java)
    if (!args.url.startsWith("https://")) {
      invoke.reject("Not a web address.")
      return
    }
    if (open(Intent(Intent.ACTION_VIEW, Uri.parse(args.url)))) invoke.resolve() else invoke.reject("No browser to open the download.")
  }

  // ---------- updates (Updater.kt) ----------

  /** Downloads and installs the APK. Answers { started: false } when Android
   *  first needs "Install unknown apps" for Togami (its settings page opens). */
  @Command
  fun updateInstall(invoke: Invoke) {
    val args = invoke.parseArgs(UrlArgs::class.java)
    if (!args.url.startsWith("https://github.com/tisdanidev/togami/")) {
      invoke.reject("Not Togami's download.")
      return
    }
    val out = JSObject()
    if (!Updater.allowed(activity)) {
      Updater.askPermission(activity)
      out.put("started", false)
    } else {
      Updater.start(activity, args.url)
      out.put("started", true)
    }
    invoke.resolve(out)
  }

  @Command
  fun updateState(invoke: Invoke) {
    val out = JSObject()
    Updater.state().forEach { (k, v) -> out.put(k, v) }
    out.put("allowed", Updater.allowed(activity))
    invoke.resolve(out)
  }

  /** "Quit": Togami goes to the background (closing the screen would stop the timer). */
  @Command
  fun exit(invoke: Invoke) {
    invoke.resolve()
    activity.moveTaskToBack(true)
  }

  /** The colour behind the status and navigation bars, and whether their icons are light. */
  @Command
  fun bars(invoke: Invoke) {
    val args = invoke.parseArgs(BarsArgs::class.java)
    val color = try {
      Color.parseColor(args.color)
    } catch (_: Exception) {
      invoke.reject("Not a colour.")
      return
    }
    activity.runOnUiThread {
      activity.window.decorView.setBackgroundColor(color)
      activity.findViewById<android.view.View>(android.R.id.content)?.setBackgroundColor(color)
      val bars = WindowCompat.getInsetsController(activity.window, activity.window.decorView)
      bars.isAppearanceLightStatusBars = !args.dark
      bars.isAppearanceLightNavigationBars = !args.dark
    }
    invoke.resolve()
  }
}
