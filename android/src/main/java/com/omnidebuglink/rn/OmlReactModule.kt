package com.omnidebuglink.rn

import android.app.Activity
import android.app.Application
import android.app.Instrumentation
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Canvas
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.os.Bundle
import android.os.Debug
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.util.Base64
import android.view.Choreographer
import android.view.KeyEvent
import android.view.MotionEvent
import android.view.View
import android.view.ViewGroup
import android.widget.EditText
import android.widget.TextView
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.ReadableMap
import com.facebook.react.bridge.UiThreadUtil
import com.facebook.react.bridge.WritableArray
import com.facebook.react.bridge.WritableMap
import com.facebook.react.uimanager.UIManagerModule
import com.facebook.react.views.textinput.ReactEditText
import java.io.ByteArrayOutputStream

/**
 * OmniDebugLink platform bridge.
 *
 * Coordinates: all inbound coordinates from JS are normalized [0,1] relative to
 * the decor view (full-screen, origin top-left). Outbound uiTree coordinates
 * are absolute screen pixels, also top-left origin.
 *
 * Touch injection dispatches MotionEvents directly on the decor view — same
 * process, so no INJECT_EVENTS permission is needed.
 */
class OmlReactModule(private val reactContext: ReactApplicationContext) :
  ReactContextBaseJavaModule(reactContext) {

  override fun getName() = "OmlReactModule"

  private val mainHandler = Handler(Looper.getMainLooper())
  private val activityStack = CopyOnWriteStack()

  init {
    // Track the activity stack for get_state. Registered once for the
    // process lifetime (module is a singleton).
    (reactContext.applicationContext as? Application)?.registerActivityLifecycleCallbacks(
      object : Application.ActivityLifecycleCallbacks {
        override fun onActivityCreated(activity: Activity, savedInstanceState: Bundle?) {
          activityStack.add(activity.javaClass.simpleName)
        }

        override fun onActivityDestroyed(activity: Activity) {
          activityStack.remove(activity.javaClass.simpleName)
        }

        override fun onActivityStarted(activity: Activity) {}
        override fun onActivityResumed(activity: Activity) {}
        override fun onActivityPaused(activity: Activity) {}
        override fun onActivityStopped(activity: Activity) {}
        override fun onActivitySaveInstanceState(activity: Activity, outState: Bundle) {}
      }
    )
  }

  // ── helpers ─────────────────────────────────────────────────────────────

  private fun decorView(): View? = currentActivity?.window?.decorView

  private fun encodeJpegWithinBudget(source: Bitmap): WritableMap {
    var bmp = source
    var quality = JPEG_START_QUALITY
    var bytes = bmp.compressJpeg(quality)
    var downsamples = 0
    // 675KB source keeps the base64 frame under the 900KB server limit.
    // Degrade quality first; once quality bottoms out, downscale 3/4 and
    // restore quality (≤3 rounds).
    while (bytes.size > JPEG_BUDGET_BYTES && downsamples < 3) {
      if (quality > JPEG_MIN_QUALITY) {
        quality -= JPEG_QUALITY_STEP
      } else {
        bmp = Bitmap.createScaledBitmap(bmp, bmp.width * 3 / 4, bmp.height * 3 / 4, true)
        downsamples++
        quality = 60
      }
      bytes = bmp.compressJpeg(quality)
    }
    val out = Arguments.createMap()
    out.putInt("width", bmp.width)
    out.putInt("height", bmp.height)
    out.putString("data", Base64.encodeToString(bytes, Base64.NO_WRAP))
    return out
  }

  private fun Bitmap.compressJpeg(quality: Int): ByteArray {
    val out = ByteArrayOutputStream()
    compress(Bitmap.CompressFormat.JPEG, quality, out)
    return out.toByteArray()
  }

  // ── multi-window support ────────────────────────────────────────────────

  /**
   * RN <Modal> (and any Dialog) lives in its OWN window with its own root
   * view — not in the activity's tree. Enumerate every window root in this
   * process via WindowManagerGlobal so screenshot/uiTree/touch can see them.
   * Order = window add order; later entries stack on top. Hidden-API
   * reflection (greylist, same technique LeakCanary uses) — on failure this
   * degrades to the single activity root and behavior matches the old
   * single-window build.
   */
  private fun allWindowRoots(): List<View> {
    val activityRoot = decorView()
    return try {
      val wmgClass = Class.forName("android.view.WindowManagerGlobal")
      val wmg = wmgClass.getMethod("getInstance").invoke(null)
      val field = wmgClass.getDeclaredField("mViews")
      field.isAccessible = true
      @Suppress("UNCHECKED_CAST")
      val views = field.get(wmg) as? ArrayList<View>
      if (views.isNullOrEmpty()) {
        listOfNotNull(activityRoot)
      } else {
        views.filter { it.visibility == View.VISIBLE }
      }
    } catch (t: Throwable) {
      listOfNotNull(activityRoot)
    }
  }

  /**
   * Pick which window a touch at screen coords should go to: topmost first
   * (list tail = top of z-order), first root whose on-screen bounds contain
   * the point. Coordinates are converted into that root's local space.
   */
  private fun touchTargetRoot(xPx: Float, yPx: Float): Triple<View, Float, Float>? {
    val roots = allWindowRoots()
    for (i in roots.indices.reversed()) {
      val root = roots[i]
      val loc = IntArray(2)
      root.getLocationOnScreen(loc)
      val lx = xPx - loc[0]
      val ly = yPx - loc[1]
      if (lx >= 0 && ly >= 0 && lx < root.width && ly < root.height) {
        return Triple(root, lx, ly)
      }
    }
    return null
  }

  private fun dispatchTapAt(view: View, xPx: Float, yPx: Float, onDone: ((Boolean) -> Unit)? = null) {
    // Real wall-clock gap between DOWN and UP with honest event timestamps —
    // RN's JS touch pipeline (unlike native View click handling) ignores
    // synthetic sequences whose UP carries a future eventTime dispatched
    // back-to-back with DOWN (verified against the android-native client,
    // where the back-to-back form works fine on plain Views).
    val downTime = SystemClock.uptimeMillis()
    val down = android.view.MotionEvent.obtain(downTime, downTime, android.view.MotionEvent.ACTION_DOWN, xPx, yPx, 0)
    view.dispatchTouchEvent(down)
    down.recycle()
    view.postDelayed({
      val upTime = SystemClock.uptimeMillis()
      val up = android.view.MotionEvent.obtain(downTime, upTime, android.view.MotionEvent.ACTION_UP, xPx, yPx, 0)
      view.dispatchTouchEvent(up)
      up.recycle()
      onDone?.invoke(true)
    }, TAP_UP_DELAY_MS)
  }

  private fun resolveViewByTag(tag: Int): View {
    // Paper architecture only; returns null under Fabric (see README)
    val uiManager = reactContext.getNativeModule(UIManagerModule::class.java)
      ?: throw IllegalStateException("UIManager unavailable (Fabric not supported yet)")
    return uiManager.resolveView(tag)
      ?: throw IllegalStateException("view not found for tag $tag")
  }

  // ── screenshot ──────────────────────────────────────────────────────────

  @ReactMethod
  fun screenshot(promise: Promise) {
    UiThreadUtil.runOnUiThread {
      try {
        val view = decorView()
          ?: return@runOnUiThread promise.reject("NO_ACTIVITY", "no foreground activity")
        if (view.width <= 0 || view.height <= 0) {
          return@runOnUiThread promise.reject("NO_SURFACE", "decor view has no size yet")
        }
        // Compose EVERY window bottom-up so RN <Modal> (own Dialog window)
        // shows up — drawing just the activity root used to skip it
        val bitmap = Bitmap.createBitmap(view.width, view.height, Bitmap.Config.ARGB_8888)
        val canvas = Canvas(bitmap)
        for (root in allWindowRoots()) {
          val loc = IntArray(2)
          root.getLocationOnScreen(loc)
          canvas.save()
          canvas.translate(-loc[0].toFloat(), -loc[1].toFloat())
          root.draw(canvas)
          canvas.restore()
        }
        val result = encodeJpegWithinBudget(bitmap)
        bitmap.recycle()
        promise.resolve(result)
      } catch (e: Exception) {
        promise.reject("SCREENSHOT_FAILED", e.message, e)
      }
    }
  }

  // ── ui_tree ─────────────────────────────────────────────────────────────

  @ReactMethod
  fun uiTree(promise: Promise) {
    UiThreadUtil.runOnUiThread {
      try {
        val base = decorView()
          ?: return@runOnUiThread promise.reject("NO_ACTIVITY", "no foreground activity")
        val counter = intArrayOf(0)
        val result = Arguments.createMap()
        result.putInt("windowWidth", base.width)
        result.putInt("windowHeight", base.height)
        result.putMap("root", dumpView(base, counter))
        // RN <Modal> content lives in Dialog windows outside the activity
        // tree — expose each as an overlayRoot so find/ui_click can reach it
        val roots = allWindowRoots()
        val overlays = roots.filter { it !== base }
        if (overlays.isNotEmpty()) {
          val arr = Arguments.createArray()
          for (o in overlays) {
            val m = dumpView(o, counter)
            m.putString("window", "dialog")
            arr.pushMap(m)
          }
          result.putArray("overlayRoots", arr)
        }
        promise.resolve(result)
      } catch (e: Exception) {
        promise.reject("UITREE_FAILED", e.message, e)
      }
    }
  }

  private fun dumpView(v: View, counter: IntArray): WritableMap {
    counter[0] += 1
    val m = Arguments.createMap()
    // RN views carry their reactTag in View.id — this is the handle ui_click /
    // input_text accept back as fieldId
    m.putInt("id", v.id)
    m.putString("type", v.javaClass.simpleName)
    if (v is TextView) {
      val text = v.text?.toString().orEmpty()
      if (text.isNotEmpty()) m.putString("text", text)
      v.hint?.let { if (it.isNotEmpty()) m.putString("hint", it.toString()) }
    }
    v.contentDescription?.let { m.putString("desc", it.toString()) }
    if (v.isClickable) m.putBoolean("clickable", true)
    if (!v.isEnabled) m.putBoolean("disabled", true)
    val loc = IntArray(2)
    v.getLocationOnScreen(loc)
    m.putInt("x", loc[0])
    m.putInt("y", loc[1])
    m.putInt("width", v.width)
    m.putInt("height", v.height)
    if (v is ViewGroup) {
      val children: WritableArray = Arguments.createArray()
      for (i in 0 until v.childCount) {
        if (counter[0] >= MAX_TREE_NODES) {
          m.putBoolean("truncated", true)
          break
        }
        children.pushMap(dumpView(v.getChildAt(i), counter))
      }
      m.putArray("children", children)
    }
    return m
  }

  // ── tap_screen ──────────────────────────────────────────────────────────

  @ReactMethod
  fun tap(x: Double, y: Double, promise: Promise) {
    UiThreadUtil.runOnUiThread {
      try {
        val dv = decorView()
          ?: return@runOnUiThread promise.reject("NO_ACTIVITY", "no foreground activity")
        // Route to the TOPMOST window covering the point — an open RN <Modal>
        // (own Dialog window) must win over the activity content beneath it
        val target = touchTargetRoot((x * dv.width).toFloat(), (y * dv.height).toFloat())
          ?: return@runOnUiThread promise.reject("NO_TOUCH_TARGET", "no window covers the requested point")
        dispatchTapAt(target.first, target.second, target.third) {
          promise.resolve(null)
        }
      } catch (e: Exception) {
        promise.reject("TAP_FAILED", e.message, e)
      }
    }
  }

  // ── long_press ──────────────────────────────────────────────────────────

  @ReactMethod
  fun longPress(x: Double, y: Double, durationMs: Double, promise: Promise) {
    UiThreadUtil.runOnUiThread {
      try {
        val dv = decorView()
          ?: return@runOnUiThread promise.reject("NO_ACTIVITY", "no foreground activity")
        val target = touchTargetRoot((x * dv.width).toFloat(), (y * dv.height).toFloat())
          ?: return@runOnUiThread promise.reject("NO_TOUCH_TARGET", "no window covers the requested point")
        val root = target.first
        val px = target.second
        val py = target.third
        val hold = durationMs.toLong().coerceIn(100, 10_000)
        val now = SystemClock.uptimeMillis()
        val down = android.view.MotionEvent.obtain(now, now, android.view.MotionEvent.ACTION_DOWN, px, py, 0)
        root.dispatchTouchEvent(down)
        // Hold without sleeping the UI thread — post the UP after the delay
        root.postDelayed({
          val up = android.view.MotionEvent.obtain(now, SystemClock.uptimeMillis(), android.view.MotionEvent.ACTION_UP, px, py, 0)
          root.dispatchTouchEvent(up)
          up.recycle()
          promise.resolve(null)
        }, hold)
        down.recycle()
      } catch (e: Exception) {
        promise.reject("LONGPRESS_FAILED", e.message, e)
      }
    }
  }

  // ── swipe ───────────────────────────────────────────────────────────────

  @ReactMethod
  fun swipe(x1: Double, y1: Double, x2: Double, y2: Double, durationMs: Double, promise: Promise) {
    UiThreadUtil.runOnUiThread {
      try {
        val dv = decorView()
          ?: return@runOnUiThread promise.reject("NO_ACTIVITY", "no foreground activity")
        val w = dv.width.toFloat()
        val h = dv.height.toFloat()
        // The gesture belongs to whichever window the STARTING point is on —
        // one gesture must not cross windows
        val target = touchTargetRoot((x1 * w).toFloat(), (y1 * h).toFloat())
          ?: return@runOnUiThread promise.reject("NO_TOUCH_TARGET", "no window covers the swipe start point")
        val view = target.first
        val loc = IntArray(2)
        view.getLocationOnScreen(loc)
        val startX = ((x1 * w) - loc[0]).toFloat()
        val startY = ((y1 * h) - loc[1]).toFloat()
        val endX = ((x2 * w) - loc[0]).toFloat()
        val endY = ((y2 * h) - loc[1]).toFloat()
        val dur = durationMs.toLong().coerceIn(50, 10_000)
        val steps = (dur / STEP_MS).toInt().coerceIn(2, 120)
        val downTime = SystemClock.uptimeMillis()

        val down = android.view.MotionEvent.obtain(downTime, downTime, android.view.MotionEvent.ACTION_DOWN, startX, startY, 0)
        view.dispatchTouchEvent(down)
        down.recycle()

        // Real-interval MOVE dispatch (postDelayed chain, ~16ms cadence): RN's
        // JS gesture pipeline needs honest timestamps, and ScrollView fling
        // derives velocity from them — a synchronous burst with future
        // timestamps behaves differently from real swipes there
        for (i in 1..steps) {
          view.postDelayed({
            val last = i == steps
            val t = i.toFloat() / steps
            val px = startX + (endX - startX) * t
            val py = startY + (endY - startY) * t
            val ev = android.view.MotionEvent.obtain(
              downTime, SystemClock.uptimeMillis(),
              if (last) android.view.MotionEvent.ACTION_UP else android.view.MotionEvent.ACTION_MOVE,
              px, py, 0
            )
            view.dispatchTouchEvent(ev)
            ev.recycle()
            if (last) promise.resolve(null)
          }, dur * i / steps)
        }
      } catch (e: Exception) {
        promise.reject("SWIPE_FAILED", e.message, e)
      }
    }
  }

  // ── ui_click ────────────────────────────────────────────────────────────

  @ReactMethod
  fun clickView(fieldId: Double, promise: Promise) {
    UiThreadUtil.runOnUiThread {
      try {
        val dv = decorView()
          ?: return@runOnUiThread promise.reject("NO_ACTIVITY", "no foreground activity")
        val target = resolveViewByTag(fieldId.toInt())
        if (target.width <= 0 || target.height <= 0) {
          return@runOnUiThread promise.reject("VIEW_INVISIBLE", "target view has no size")
        }
        val doTap = {
          // Re-resolve center AFTER any scroll settles — coordinates captured
          // before requestRectangleOnScreen would be stale.
          // Dispatch on the root of the view's OWN window: a target inside
          // RN <Modal> lives in a Dialog window and would never be hit
          // through the activity decor view.
          val root = target.rootView
          val targetLoc = IntArray(2)
          target.getLocationOnScreen(targetLoc)
          val rootLoc = IntArray(2)
          root.getLocationOnScreen(rootLoc)
          val cx = (targetLoc[0] - rootLoc[0] + target.width / 2f)
          val cy = (targetLoc[1] - rootLoc[1] + target.height / 2f)
          val inDialog = root !== dv
          dispatchTapAt(root, cx, cy) {
            // visibility bound only meaningful in the activity window;
            // dialog content is always "on screen" for hit purposes
            promise.resolve(inDialog || (cy >= 0 && cy <= root.height))
          }
        }
        // Off-screen bring-back only applies to activity-window targets —
        // dialog windows don't participate in the activity's scroll
        val inDialogWindow = target.rootView !== dv
        if (!inDialogWindow) {
          val targetLoc = IntArray(2)
          target.getLocationOnScreen(targetLoc)
          val dvLoc = IntArray(2)
          dv.getLocationOnScreen(dvLoc)
          val top = targetLoc[1] - dvLoc[1]
          if (top < 0 || top + target.height > dv.height) {
            target.requestRectangleOnScreen(android.graphics.Rect(0, 0, target.width, target.height))
            // standard smooth-scroll animation is ~250ms; tap after it settles
            dv.postDelayed(doTap, SCROLL_SETTLE_MS)
            return@runOnUiThread
          }
        }
        doTap()
      } catch (e: Exception) {
        promise.reject("CLICK_FAILED", e.message, e)
      }
    }
  }

  // ── input_text ──────────────────────────────────────────────────────────

  @ReactMethod
  fun inputText(fieldId: Double, text: String, promise: Promise) {
    UiThreadUtil.runOnUiThread {
      try {
        val view = resolveViewByTag(fieldId.toInt())
        when (view) {
          is ReactEditText -> view.setText(text)
          is EditText -> view.setText(text)
          is TextView -> view.text = text
          else -> return@runOnUiThread promise.reject(
            "NOT_A_TEXT_FIELD",
            "target is ${view.javaClass.simpleName}, not a text field"
          )
        }
        promise.resolve(null)
      } catch (e: Exception) {
        promise.reject("INPUT_FAILED", e.message, e)
      }
    }
  }

  // ── send_key ────────────────────────────────────────────────────────────

  @ReactMethod
  fun sendKey(key: String, promise: Promise) {
    UiThreadUtil.runOnUiThread {
      try {
        when (key) {
          "back" -> {
            val activity = currentActivity
              ?: return@runOnUiThread promise.reject("NO_ACTIVITY", "no foreground activity")
            // A dialog/overlay (AlertDialog lives in its own window) steals
            // window focus. In-process dispatchKeyEvent bypasses the system's
            // focused-window routing, so back would sail past the dialog and
            // hit the activity's onBackPressed — finishing the activity
            // under the dialog (verified on device: app appeared to crash).
            // Refuse instead of misfiring.
            if (!activity.hasWindowFocus()) {
              return@runOnUiThread promise.reject(
                "WINDOW_NOT_FOCUSED",
                "activity window lost focus (dialog/overlay showing?) — in-process back cannot reach it and would finish the activity instead; dismiss via the dialog's own button (ui_click)"
              )
            }
            val now = SystemClock.uptimeMillis()
            val down = KeyEvent(now, now, KeyEvent.ACTION_DOWN, KeyEvent.KEYCODE_BACK, 0)
            val up = KeyEvent(now, now + 10, KeyEvent.ACTION_UP, KeyEvent.KEYCODE_BACK, 0)
            activity.dispatchKeyEvent(down)
            activity.dispatchKeyEvent(up)
            promise.resolve(true)
          }
          "home", "recents" -> {
            val keyCode = if (key == "home") KeyEvent.KEYCODE_HOME else KeyEvent.KEYCODE_APP_SWITCH
            try {
              // Same-process instrumentation injection; the system may refuse
              Instrumentation().sendKeyDownUpSync(keyCode)
              promise.resolve(true)
            } catch (se: SecurityException) {
              if (key == "home") {
                // Fallback: go home via the launcher intent
                val intent = Intent(Intent.ACTION_MAIN)
                  .addCategory(Intent.CATEGORY_HOME)
                  .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                reactContext.startActivity(intent)
                promise.resolve(true)
              } else {
                promise.reject("KEY_REJECTED", "recents injection rejected by system", se)
              }
            }
          }
          else -> promise.reject(
            "KEY_UNSUPPORTED",
            "Android supports back/home/recents (software keys live in the web/Flutter sense are not injectable here)"
          )
        }
      } catch (e: Exception) {
        promise.reject("KEY_FAILED", e.message, e)
      }
    }
  }

  // ── get_state ───────────────────────────────────────────────────────────

  @ReactMethod
  fun getState(promise: Promise) {
    try {
      val result = Arguments.createMap()
      val dm = reactContext.resources.displayMetrics
      val screen = Arguments.createMap()
      screen.putInt("width", dm.widthPixels)
      screen.putInt("height", dm.heightPixels)
      screen.putDouble("density", dm.density.toDouble())
      result.putMap("screen", screen)

      val network = Arguments.createMap()
      try {
        val cm = reactContext.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
        val caps = cm.getNetworkCapabilities(cm.activeNetwork)
        if (caps == null) {
          network.putBoolean("connected", false)
          network.putString("type", "none")
        } else {
          network.putBoolean(
            "connected",
            caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
          )
          network.putString(
            "type",
            when {
              caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) -> "wifi"
              caps.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR) -> "cellular"
              caps.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET) -> "ethernet"
              else -> "other"
            }
          )
        }
      } catch (e: Exception) {
        network.putBoolean("connected", false)
        network.putString("type", "unknown")
      }
      result.putMap("network", network)

      val activities: WritableArray = Arguments.createArray()
      activityStack.snapshot().forEach(activities::pushString)
      // The module initializes after the host activity's onCreate has already
      // fired (ReactContext builds inside it), so the very first activity is
      // never caught by the lifecycle callback — fall back to the live one
      if (activities.size() == 0) {
        currentActivity?.let { activities.pushString(it.javaClass.simpleName) }
      }
      result.putArray("activities", activities)
      promise.resolve(result)
    } catch (e: Exception) {
      promise.reject("STATE_FAILED", e.message, e)
    }
  }

  // ── get_perf ────────────────────────────────────────────────────────────

  @ReactMethod
  fun getPerf(promise: Promise) {
    UiThreadUtil.runOnUiThread {
      try {
        // Memory snapshot (a few ms on the UI thread, tolerable)
        val mi = Debug.MemoryInfo()
        Debug.getMemoryInfo(mi)
        val rt = Runtime.getRuntime()

        // fps: sample Choreographer frames for ~1s (must be main thread)
        val stamps = ArrayList<Long>()
        val choreographer = Choreographer.getInstance()
        val sampleStart = System.nanoTime()
        val frameCb = object : Choreographer.FrameCallback {
          override fun doFrame(frameTimeNanos: Long) {
            stamps.add(frameTimeNanos)
            if (frameTimeNanos - sampleStart < PERF_SAMPLE_NS) {
              choreographer.postFrameCallback(this)
            }
          }
        }
        choreographer.postFrameCallback(frameCb)
        mainHandler.postDelayed({
          try {
            val m = Arguments.createMap()
            val fps = Arguments.createMap()
            if (stamps.size >= 2) {
              val durS = (stamps.last() - stamps.first()) / 1e9
              fps.putDouble("fps", (stamps.size - 1) / durS)
              fps.putInt("sampledFrames", stamps.size)
              val gaps = (1 until stamps.size)
                .map { (stamps[it] - stamps[it - 1]) / 1e6 }
                .sorted()
              val frameMs = Arguments.createMap()
              frameMs.putDouble("p50", percentile(gaps, 0.50))
              frameMs.putDouble("p95", percentile(gaps, 0.95))
              frameMs.putDouble("p99", percentile(gaps, 0.99))
              fps.putMap("frameMs", frameMs)
            } else {
              fps.putDouble("fps", 0.0)
              fps.putInt("sampledFrames", stamps.size)
              fps.putString("hint", "0 frames sampled — screen idle or no rendering during the 1s window")
            }
            m.putMap("fps", fps)

            val memory = Arguments.createMap()
            memory.putDouble("javaHeapMax", rt.maxMemory() / 1.0e6)
            memory.putDouble("javaHeapUsed", (rt.totalMemory() - rt.freeMemory()) / 1.0e6)
            memory.putDouble("pssTotal", mi.totalPss / 1.0e3)
            memory.putDouble("pssJava", mi.dalvikPss / 1.0e3)
            memory.putDouble("pssNative", mi.nativePss / 1.0e3)
            m.putMap("memory", memory)
            m.putInt("threads", Thread.activeCount())
            promise.resolve(m)
          } catch (e: Exception) {
            promise.reject("PERF_FAILED", e.message, e)
          }
        }, PERF_SAMPLE_MS + 60)
      } catch (e: Exception) {
        promise.reject("PERF_FAILED", e.message, e)
      }
    }
  }

  private fun percentile(sorted: List<Double>, p: Double): Double {
    if (sorted.isEmpty()) return 0.0
    val idx = ((sorted.size - 1) * p).toInt().coerceIn(0, sorted.size - 1)
    return sorted[idx]
  }

  // ── view_component ──────────────────────────────────────────────────────

  @ReactMethod
  fun viewComponent(fieldId: Double, promise: Promise) {
    UiThreadUtil.runOnUiThread {
      try {
        val v = resolveViewByTag(fieldId.toInt())
        val m = Arguments.createMap()
        m.putInt("id", v.id)
        m.putString("type", v.javaClass.simpleName)
        m.putDouble("alpha", v.alpha.toDouble())
        m.putString(
          "visibility",
          when (v.visibility) {
            View.VISIBLE -> "visible"
            View.INVISIBLE -> "invisible"
            else -> "gone"
          }
        )
        m.putBoolean("enabled", v.isEnabled)
        m.putBoolean("clickable", v.isClickable)
        m.putBoolean("selected", v.isSelected)
        m.putBoolean("focused", v.isFocused)
        val loc = IntArray(2)
        v.getLocationOnScreen(loc)
        m.putInt("x", loc[0])
        m.putInt("y", loc[1])
        m.putInt("width", v.width)
        m.putInt("height", v.height)
        if (v is TextView) {
          m.putString("text", v.text?.toString().orEmpty())
          v.hint?.let { m.putString("hint", it.toString()) }
          m.putDouble("textSize", v.textSize.toDouble())
        }
        promise.resolve(m)
      } catch (e: Exception) {
        promise.reject("VIEWCOMP_FAILED", e.message, e)
      }
    }
  }

  // ── prefs ───────────────────────────────────────────────────────────────

  private fun prefs(): android.content.SharedPreferences =
    reactContext.getSharedPreferences("${reactContext.packageName}_preferences", Context.MODE_PRIVATE)

  private fun putPrefValue(m: WritableMap, key: String, value: Any?) {
    m.putMap(key, buildPrefEntry(value))
  }

  @ReactMethod
  fun prefsGet(key: String, promise: Promise) {
    try {
      val value = prefs().all[key]
      if (value == null) {
        promise.resolve(null)
        return
      }
      // Build the entry map directly — resolving a ReadableNativeMap obtained
      // from WritableMap.getMap() throws "Cannot convert ReadableNativeMap"
      promise.resolve(buildPrefEntry(value))
    } catch (e: Exception) {
      promise.reject("PREFS_FAILED", e.message, e)
    }
  }

  private fun buildPrefEntry(value: Any?): WritableMap {
    val e = Arguments.createMap()
    when (value) {
      is String -> { e.putString("value", value); e.putString("valueType", "string") }
      is Boolean -> { e.putBoolean("value", value); e.putString("valueType", "bool") }
      is Int -> { e.putDouble("value", value.toDouble()); e.putString("valueType", "int") }
      is Long -> { e.putDouble("value", value.toDouble()); e.putString("valueType", "long") }
      is Float -> { e.putDouble("value", value.toDouble()); e.putString("valueType", "float") }
      else -> { e.putNull("value"); e.putString("valueType", "string") }
    }
    return e
  }

  @ReactMethod
  fun prefsSet(opts: ReadableMap, promise: Promise) {
    try {
      val key = opts.getString("key")
        ?: return promise.reject("PREFS_INVALID", "key required")
      val valueType = opts.getString("valueType") ?: "string"
      val ed = prefs().edit()
      when (valueType) {
        "bool" -> ed.putBoolean(key, opts.getBoolean("value"))
        "int" -> ed.putInt(key, opts.getInt("value"))
        "long" -> ed.putLong(key, opts.getInt("value").toLong())
        "float" -> ed.putFloat(key, opts.getDouble("value").toFloat())
        else -> ed.putString(key, opts.getString("value"))
      }
      ed.apply()
      promise.resolve(null)
    } catch (e: Exception) {
      promise.reject("PREFS_FAILED", e.message, e)
    }
  }

  @ReactMethod
  fun prefsDelete(key: String, promise: Promise) {
    try {
      val had = prefs().contains(key)
      prefs().edit().remove(key).apply()
      promise.resolve(had)
    } catch (e: Exception) {
      promise.reject("PREFS_FAILED", e.message, e)
    }
  }

  @ReactMethod
  fun prefsList(promise: Promise) {
    try {
      val m = Arguments.createMap()
      prefs().all.forEach { (k, v) -> putPrefValue(m, k, v) }
      promise.resolve(m)
    } catch (e: Exception) {
      promise.reject("PREFS_FAILED", e.message, e)
    }
  }

  // ── misc ────────────────────────────────────────────────────────────────

  /** Minimal thread-safe stack for activity names. */
  private class CopyOnWriteStack {
    private val items = java.util.concurrent.CopyOnWriteArrayList<String>()
    fun add(item: String) = items.add(item)
    fun remove(item: String) = items.remove(item)
    fun snapshot(): List<String> = items.toList()
  }

  companion object {
    private const val MAX_TREE_NODES = 3000
    private const val TAP_UP_DELAY_MS = 80L
    private const val STEP_MS = 16L
    private const val SCROLL_SETTLE_MS = 320L
    private const val JPEG_START_QUALITY = 82
    private const val JPEG_MIN_QUALITY = 30
    private const val JPEG_QUALITY_STEP = 15
    private const val JPEG_BUDGET_BYTES = 675_000
    private const val PERF_SAMPLE_MS = 1000L
    private const val PERF_SAMPLE_NS = 1_000_000_000L
  }
}
