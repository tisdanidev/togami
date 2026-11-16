// Notification access, which Android requires before an app may read other
// apps' media sessions (now playing). Togami doesn't read notifications: this
// service only has to exist and be allowed. TogamiPlugin.mediaNow() does the
// reading with MediaSessionManager.

package dev.tisdani.togami

import android.service.notification.NotificationListenerService

class MediaListener : NotificationListenerService()
