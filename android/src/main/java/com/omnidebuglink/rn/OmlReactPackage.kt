package com.omnidebuglink.rn

import com.facebook.react.ReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.uimanager.ViewManager

/**
 * Autolinked ReactPackage exposing [OmlReactModule].
 * RN 0.60+ CLI autolinking picks this up automatically — no manual
 * MainApplication registration needed on standard projects.
 */
class OmlReactPackage : ReactPackage {
  override fun createNativeModules(reactContext: ReactApplicationContext): List<NativeModule> =
    listOf(OmlReactModule(reactContext))

  override fun createViewManagers(reactContext: ReactApplicationContext): List<ViewManager<*, *>> =
    emptyList()
}
