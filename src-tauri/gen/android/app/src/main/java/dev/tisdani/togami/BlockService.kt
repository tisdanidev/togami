// Togami's Accessibility service: the Android side of blocking. The Rust
// blocker (src-tauri/src/blocker.rs) asks a few times a second which app is
// in front (front()) and matches it against the blocklist with rules.rs; a
// blocked app or site is sent to the home screen and Togami opens on top
// (pushAway()). Browsers report their address bar, read by its view id.
//
// The service reads nothing else and keeps nothing: it only answers front().
// It's switched on by the user in Settings > Accessibility > Togami. On
// Android 13+ an app installed from a file first needs "Allow restricted
// settings" in its App info menu.

package dev.tisdani.togami

import android.accessibilityservice.AccessibilityService
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo
import app.tauri.plugin.JSObject

class BlockService : AccessibilityService() {
  companion object {
    @Volatile
    var instance: BlockService? = null
      private set

    /** Browser package -> (name rules.rs knows, address bar view ids). */
    private val BROWSERS: Map<String, Pair<String, List<String>>> = mapOf(
      "com.android.chrome" to ("chrome" to listOf("url_bar")),
      "com.chrome.beta" to ("chrome" to listOf("url_bar")),
      "com.chrome.dev" to ("chrome" to listOf("url_bar")),
      "com.chrome.canary" to ("chrome" to listOf("url_bar")),
      "com.microsoft.emmx" to ("msedge" to listOf("url_bar")),
      "com.brave.browser" to ("brave" to listOf("url_bar")),
      "com.vivaldi.browser" to ("vivaldi" to listOf("url_bar")),
      "org.chromium.chrome" to ("chromium" to listOf("url_bar")),
      "com.kiwibrowser.browser" to ("chromium" to listOf("url_bar")),
      "org.mozilla.firefox" to ("firefox" to listOf("mozac_browser_toolbar_url_view", "url_bar_title", "ADDRESSBAR_URL_BOX")),
      "org.mozilla.firefox_beta" to ("firefox" to listOf("mozac_browser_toolbar_url_view", "url_bar_title", "ADDRESSBAR_URL_BOX")),
      "org.mozilla.fenix" to ("firefox" to listOf("mozac_browser_toolbar_url_view", "url_bar_title", "ADDRESSBAR_URL_BOX")),
      "org.mozilla.focus" to ("firefox" to listOf("mozac_browser_toolbar_url_view", "display_url")),
      "com.sec.android.app.sbrowser" to ("samsunginternet" to listOf("location_bar_edit_text", "custom_tab_toolbar_url_bar_text")),
      "com.sec.android.app.sbrowser.beta" to ("samsunginternet" to listOf("location_bar_edit_text", "custom_tab_toolbar_url_bar_text")),
      "com.opera.browser" to ("opera" to listOf("url_field", "url_bar")),
      "com.opera.gx" to ("operagx" to listOf("url_field", "url_bar")),
      "com.opera.mini.native" to ("opera" to listOf("url_field")),
      "com.duckduckgo.mobile.android" to ("duckduckgo" to listOf("omnibarTextInput")),
      "com.ecosia.android" to ("chromium" to listOf("url_bar")),
    )

    /** Never touched, whatever the lists say (like NEVER in rules.rs). */
    private val NEVER = setOf(
      "android", "com.android.systemui", "com.android.settings", "com.samsung.android.app.settings",
      "com.android.phone", "com.android.dialer", "com.google.android.dialer", "com.samsung.android.dialer",
      "com.samsung.android.incallui", "com.android.server.telecom", "com.android.emergency",
      "com.google.android.packageinstaller", "com.android.packageinstaller",
      "com.google.android.permissioncontroller", "com.android.permissioncontroller",
      "com.samsung.android.app.routines", "com.android.intentresolver",
    )
  }

  private val main = Handler(Looper.getMainLooper())
  private val labels = HashMap<String, String>()
  private var launchers: Set<String> = emptySet()

  override fun onServiceConnected() {
    super.onServiceConnected()
    instance = this
    launchers = try {
      val home = Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_HOME)
      packageManager.queryIntentActivities(home, PackageManager.MATCH_DEFAULT_ONLY).map { it.activityInfo.packageName }.toSet()
    } catch (_: Exception) {
      emptySet()
    }
  }

  override fun onAccessibilityEvent(event: AccessibilityEvent?) {}

  override fun onInterrupt() {}

  override fun onDestroy() {
    if (instance === this) instance = null
    super.onDestroy()
  }

  override fun onUnbind(intent: Intent?): Boolean {
    if (instance === this) instance = null
    return super.onUnbind(intent)
  }

  private fun ignored(pkg: String): Boolean {
    if (pkg == packageName || pkg in NEVER || pkg in launchers) return true
    val ime = Settings.Secure.getString(contentResolver, Settings.Secure.DEFAULT_INPUT_METHOD)
    return ime != null && ime.startsWith("$pkg/")
  }

  private fun label(pkg: String): String = labels.getOrPut(pkg) {
    try {
      packageManager.getApplicationLabel(packageManager.getApplicationInfo(pkg, 0)).toString()
    } catch (_: Exception) {
      ""
    }
  }

  /** The app in front: { package, exe, url? }, or null for Togami, the home screen and system UI. */
  fun front(): JSObject? {
    val root = try {
      rootInActiveWindow
    } catch (_: Exception) {
      null
    } ?: return null
    val pkg = root.packageName?.toString() ?: return null
    if (ignored(pkg)) return null
    val out = JSObject()
    out.put("package", pkg)
    val browser = BROWSERS[pkg]
    if (browser != null) {
      out.put("exe", browser.first)
      // a dialog or menu over the page is its own window: then look in the browser's other windows
      val url = readUrl(root, pkg, browser.second) ?: try {
        windows.mapNotNull { it.root }.filter { it.packageName?.toString() == pkg && it != root }.firstNotNullOfOrNull { readUrl(it, pkg, browser.second) }
      } catch (_: Exception) {
        null
      }
      url?.let { out.put("url", it) }
    } else {
      // rules.rs matches a blocked app's name anywhere in here
      out.put("exe", "${label(pkg)} $pkg")
    }
    return out
  }

  /** The address bar's text, by its view id, else a text box whose id looks like one. */
  private fun readUrl(root: AccessibilityNodeInfo, pkg: String, ids: List<String>): String? {
    for (id in ids) {
      val nodes = try {
        root.findAccessibilityNodeInfosByViewId("$pkg:id/$id")
      } catch (_: Exception) {
        null
      } ?: continue
      for (n in nodes) {
        val text = n.text?.toString()?.trim()
        if (!text.isNullOrEmpty()) return text
      }
    }
    // fallback for new browser versions: look through the toolbar for an address box
    val queue = ArrayDeque<AccessibilityNodeInfo>()
    queue.add(root)
    var seen = 0
    while (queue.isNotEmpty() && seen < 600) {
      val n = queue.removeFirst()
      seen++
      val id = n.viewIdResourceName?.lowercase() ?: ""
      if (id.contains("url") || id.contains("location_bar") || id.contains("omnibox") || id.contains("address")) {
        val text = n.text?.toString()?.trim()
        if (!text.isNullOrEmpty() && !text.contains(' ') && text.contains('.')) return text
      }
      // page content is a web view; the toolbar is never inside it
      if (n.className?.toString() == "android.webkit.WebView") continue
      for (i in 0 until n.childCount) n.getChild(i)?.let { queue.add(it) }
    }
    return null
  }

  /** Home screen, then Togami on top (its block screen is shown by the UI). */
  fun pushAway() {
    main.post {
      performGlobalAction(GLOBAL_ACTION_HOME)
      main.postDelayed({
        try {
          val open = Intent(this, MainActivity::class.java)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_REORDER_TO_FRONT or Intent.FLAG_ACTIVITY_SINGLE_TOP)
          startActivity(open)
        } catch (_: Exception) {
        }
      }, 250)
    }
  }
}
