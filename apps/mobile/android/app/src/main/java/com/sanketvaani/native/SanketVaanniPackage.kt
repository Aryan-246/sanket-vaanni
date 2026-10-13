package com.sanketvaani.native

import com.facebook.react.ReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.uimanager.ViewManager

/**
 * Registers the app's own native module.
 *
 * Autolinking covers third-party packages; a module that lives inside `app/`
 * has to be added to the package list by hand, which is done in
 * `MainApplication`. Nothing else about the build changes.
 */
class SanketVaanniPackage : ReactPackage {
  override fun createNativeModules(
    reactContext: ReactApplicationContext,
  ): List<NativeModule> = listOf(SanketVaanniModule(reactContext))

  override fun createViewManagers(
    reactContext: ReactApplicationContext,
  ): List<ViewManager<*, *>> = emptyList()
}
