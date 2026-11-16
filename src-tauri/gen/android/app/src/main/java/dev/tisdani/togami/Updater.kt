// The Android auto-updater. Togami downloads the new APK itself and hands it
// to Android's PackageInstaller:
//   - the first time, Android asks the user to let Togami install apps
//     ("Install unknown apps"), then shows its "Update Togami?" dialog
//   - on Android 12+, once Togami has installed itself, later updates go
//     through without a dialog (setRequireUserAction(NOT_REQUIRED))
// Android only installs the APK over the old app if it's signed with the same
// key, and the APK is checked here first (same package, same signer) so a
// wrong file gives a clear message instead of Android's generic one.
//
// The UI polls state() while this runs (no plugin events, which would need
// their own permission entry). Android stops Togami to replace it, so
// UpdateReceiver posts a notification (and tries to reopen Togami) once the
// new version is in place.

package dev.tisdani.togami

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInfo
import android.content.pm.PackageInstaller
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.provider.Settings
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest

object Updater {
  // what the UI shows: idle, downloading, installing, confirm, error
  @Volatile var phase = "idle"
  @Volatile var done = 0L
  @Volatile var total = 0L
  @Volatile var error = ""

  private const val ACTION_STATUS = "dev.tisdani.togami.UPDATE_STATUS"

  fun state(): Map<String, Any> = mapOf("phase" to phase, "done" to done, "total" to total, "error" to error)

  /** May Togami install APKs? (Android 8+ asks per app; before that, "Unknown sources" covers it.) */
  fun allowed(context: Context): Boolean =
    Build.VERSION.SDK_INT < Build.VERSION_CODES.O || context.packageManager.canRequestPackageInstalls()

  /** Android's "Install unknown apps" page for Togami. */
  fun askPermission(context: Context) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    val intent = Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:${context.packageName}"))
    try {
      context.startActivity(intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    } catch (_: Exception) {
      context.startActivity(Intent(Settings.ACTION_SECURITY_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    }
  }

  /** Downloads and installs on a background thread. Returns false if one is already running. */
  @Synchronized
  fun start(context: Context, url: String): Boolean {
    if (phase == "downloading" || phase == "installing") return false
    phase = "downloading"
    done = 0
    total = 0
    error = ""
    val app = context.applicationContext
    Thread {
      try {
        val apk = download(app, url)
        check(app, apk)
        phase = "installing"
        install(app, apk)
      } catch (e: Exception) {
        fail(e.message ?: "Something went wrong.")
      }
    }.apply { name = "togami-update"; isDaemon = true }.start()
    return true
  }

  fun fail(message: String) {
    error = message
    phase = "error"
  }

  private fun download(context: Context, url: String): File {
    val dir = File(context.cacheDir, "update").apply { mkdirs() }
    dir.listFiles()?.forEach { it.delete() }
    val file = File(dir, "togami.apk")
    var link = url
    // GitHub sends the download on to its file host; follow https redirects only
    for (hop in 0 until 6) {
      val conn = (URL(link).openConnection() as HttpURLConnection).apply {
        instanceFollowRedirects = false
        connectTimeout = 20_000
        readTimeout = 30_000
        setRequestProperty("User-Agent", "Togami-Android")
      }
      try {
        val code = conn.responseCode
        if (code in 300..399) {
          val next = conn.getHeaderField("Location") ?: throw Exception("The download moved somewhere unknown.")
          link = URL(URL(link), next).toString()
          if (!link.startsWith("https://")) throw Exception("The download isn't secure.")
          continue
        }
        if (code != 200) throw Exception("GitHub answered with an error ($code).")
        total = conn.contentLengthLong.coerceAtLeast(0)
        conn.inputStream.use { input ->
          file.outputStream().use { out ->
            val buf = ByteArray(64 * 1024)
            while (true) {
              val n = input.read(buf)
              if (n < 0) break
              out.write(buf, 0, n)
              done += n
            }
          }
        }
        if (total > 0 && done != total) throw Exception("The download stopped early. Are you online?")
        return file
      } catch (e: java.io.IOException) {
        throw Exception("The download failed. Are you online?")
      } finally {
        conn.disconnect()
      }
    }
    throw Exception("The download was redirected too many times.")
  }

  /** Same package and the same signing key as this Togami, or Android would refuse it anyway. */
  private fun check(context: Context, apk: File) {
    val pm = context.packageManager
    val flags = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) PackageManager.GET_SIGNING_CERTIFICATES else @Suppress("DEPRECATION") PackageManager.GET_SIGNATURES
    val archive = pm.getPackageArchiveInfo(apk.path, flags) ?: throw Exception("The downloaded file isn't an Android app.")
    if (archive.packageName != context.packageName) throw Exception("The downloaded app isn't Togami.")
    val mine = signers(pm.getPackageInfo(context.packageName, flags))
    val theirs = signers(archive)
    // some Android versions don't read an archive's signers; Android checks them again when installing
    if (mine.isNotEmpty() && theirs.isNotEmpty() && mine != theirs) {
      throw Exception("This update is signed with a different key, so Android can't install it over Togami.")
    }
  }

  private fun signers(info: PackageInfo): Set<String> {
    val sigs = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
      val s = info.signingInfo ?: return emptySet()
      if (s.hasMultipleSigners()) s.apkContentsSigners else s.signingCertificateHistory
    } else {
      @Suppress("DEPRECATION") info.signatures
    } ?: return emptySet()
    val sha = MessageDigest.getInstance("SHA-256")
    return sigs.map { sha.digest(it.toByteArray()).joinToString("") { b -> "%02x".format(b) } }.toSet()
  }

  private fun install(context: Context, apk: File) {
    val installer = context.packageManager.packageInstaller
    val params = PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL).apply {
      setAppPackageName(context.packageName)
      setSize(apk.length())
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
        // no dialog when Togami installed the current version itself
        setRequireUserAction(PackageInstaller.SessionParams.USER_ACTION_NOT_REQUIRED)
      }
    }
    val id = installer.createSession(params)
    installer.openSession(id).use { session ->
      session.openWrite("togami.apk", 0, apk.length()).use { out ->
        apk.inputStream().use { it.copyTo(out) }
        session.fsync(out)
      }
      val intent = Intent(context, UpdateReceiver::class.java).setAction(ACTION_STATUS)
      val mutable = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) PendingIntent.FLAG_MUTABLE else 0
      val pending = PendingIntent.getBroadcast(context, id, intent, PendingIntent.FLAG_UPDATE_CURRENT or mutable)
      session.commit(pending.intentSender)
    }
  }

  /** Called when Android has replaced Togami: a notification to open the new version. */
  fun announce(context: Context) {
    try {
      val launch = context.packageManager.getLaunchIntentForPackage(context.packageName) ?: return
      launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      val nm = context.getSystemService(NotificationManager::class.java)
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        nm.createNotificationChannel(NotificationChannel("updates", "Updates", NotificationManager.IMPORTANCE_DEFAULT))
      }
      val version = try {
        context.packageManager.getPackageInfo(context.packageName, 0).versionName ?: ""
      } catch (_: Exception) {
        ""
      }
      val tap = PendingIntent.getActivity(context, 0, launch, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
      val note = NotificationCompat.Builder(context, "updates")
        .setSmallIcon(context.applicationInfo.icon)
        .setContentTitle("Togami $version is installed")
        .setContentText("Tap to open it.")
        .setContentIntent(tap)
        .setAutoCancel(true)
        .build()
      val mayNotify = Build.VERSION.SDK_INT < 33 ||
        ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED
      if (mayNotify) NotificationManagerCompat.from(context).notify(NOTE_ID, note)
      // reopening straight away works where Android allows it; the notification covers the rest
      try {
        context.startActivity(launch)
      } catch (_: Exception) {
      }
    } catch (_: Exception) {
    }
  }

  const val NOTE_ID = 4207
}

/** PackageInstaller's answers, and the "Togami was replaced" broadcast. */
class UpdateReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    if (intent.action == Intent.ACTION_MY_PACKAGE_REPLACED) {
      Updater.announce(context)
      return
    }
    when (intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE)) {
      PackageInstaller.STATUS_PENDING_USER_ACTION -> {
        // Android's "Update Togami?" dialog
        @Suppress("DEPRECATION")
        val confirm = intent.getParcelableExtra<Intent>(Intent.EXTRA_INTENT)
        if (confirm == null) {
          Updater.fail("Android didn't show its install dialog.")
          return
        }
        Updater.phase = "confirm"
        try {
          context.startActivity(confirm.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        } catch (_: Exception) {
          Updater.fail("Android didn't show its install dialog.")
        }
      }
      PackageInstaller.STATUS_SUCCESS -> Updater.phase = "installing" // Android stops Togami to replace it
      PackageInstaller.STATUS_FAILURE_ABORTED -> Updater.fail("The update was cancelled.")
      PackageInstaller.STATUS_FAILURE_CONFLICT,
      PackageInstaller.STATUS_FAILURE_INCOMPATIBLE -> Updater.fail("Android can't install this update over Togami (it may be signed with a different key).")
      PackageInstaller.STATUS_FAILURE_STORAGE -> Updater.fail("There isn't enough free space for the update.")
      else -> Updater.fail(intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE) ?: "Android couldn't install the update.")
    }
  }
}
