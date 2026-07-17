// Android bridge to the Moonlight streaming engine.
//
// Preferred path: the EMBEDDED engine — a libraryized fork of
// moonlight-android compiled into this APK (Phase 3), reached by firing the
// ShortcutTrampoline activity within our own package. Fallback: the external
// Moonlight app (com.limelight) for builds without the embedded module.
//
// Uses JNI directly against the Android context that Tauri/wry register via
// ndk-context — no separate plugin crate needed.

#[cfg(target_os = "android")]
mod android {
    use jni::objects::{JObject, JString, JValue};

    const MOONLIGHT_PACKAGE: &str = "com.limelight";
    const TRAMPOLINE: &str = "com.limelight.ShortcutTrampoline";
    const PC_VIEW: &str = "com.limelight.PcView";
    const FLAG_ACTIVITY_NEW_TASK: i32 = 0x1000_0000;

    fn with_env<T>(
        f: impl FnOnce(&mut jni::JNIEnv, &JObject) -> Result<T, jni::errors::Error>,
    ) -> Result<T, String> {
        let ctx = ndk_context::android_context();
        let vm = unsafe { jni::JavaVM::from_raw(ctx.vm().cast()) }.map_err(|e| e.to_string())?;
        let mut env = vm.attach_current_thread().map_err(|e| e.to_string())?;
        let context = unsafe { JObject::from_raw(ctx.context().cast()) };
        let result = f(&mut env, &context);
        // A pending Java exception left on the thread ABORTS the process on
        // the next JNI call — always clear it before surfacing the error.
        if result.is_err() && env.exception_check().unwrap_or(false) {
            let _ = env.exception_clear();
        }
        result.map_err(|e| e.to_string())
    }

    fn our_package(
        env: &mut jni::JNIEnv,
        context: &JObject,
    ) -> Result<String, jni::errors::Error> {
        let pkg = env
            .call_method(context, "getPackageName", "()Ljava/lang/String;", &[])?
            .l()?;
        let pkg: JString = pkg.into();
        // Bind the JavaStr before converting: the borrow of `pkg` must not
        // live inside the return expression (E0597 on the Android target).
        let java_str = env.get_string(&pkg)?;
        let name = String::from(java_str);
        Ok(name)
    }

    /// Builds an intent for `package`/`class`, returns None when the activity
    /// doesn't resolve (e.g. embedded engine absent, external app missing).
    fn build_resolved_intent<'a>(
        env: &mut jni::JNIEnv<'a>,
        context: &JObject,
        package: &str,
        class: &str,
        extras: &[(&str, &str)],
    ) -> Result<Option<JObject<'a>>, jni::errors::Error> {
        let intent_class = env.find_class("android/content/Intent")?;
        let intent = env.new_object(intent_class, "()V", &[])?;

        let pkg = env.new_string(package)?;
        let cls = env.new_string(class)?;
        env.call_method(
            &intent,
            "setClassName",
            "(Ljava/lang/String;Ljava/lang/String;)Landroid/content/Intent;",
            &[(&pkg).into(), (&cls).into()],
        )?;

        // Verify the component exists before trying to start it
        let pm = env
            .call_method(
                context,
                "getPackageManager",
                "()Landroid/content/pm/PackageManager;",
                &[],
            )?
            .l()?;
        let resolved = env
            .call_method(
                &intent,
                "resolveActivity",
                "(Landroid/content/pm/PackageManager;)Landroid/content/ComponentName;",
                &[(&pm).into()],
            )?
            .l()?;
        if resolved.is_null() {
            return Ok(None);
        }

        for (key, value) in extras {
            let k = env.new_string(*key)?;
            let v = env.new_string(*value)?;
            env.call_method(
                &intent,
                "putExtra",
                "(Ljava/lang/String;Ljava/lang/String;)Landroid/content/Intent;",
                &[(&k).into(), (&v).into()],
            )?;
        }

        env.call_method(
            &intent,
            "addFlags",
            "(I)Landroid/content/Intent;",
            &[JValue::Int(FLAG_ACTIVITY_NEW_TASK)],
        )?;
        Ok(Some(intent))
    }

    fn start(env: &mut jni::JNIEnv, context: &JObject, intent: &JObject) -> Result<(), jni::errors::Error> {
        env.call_method(
            context,
            "startActivity",
            "(Landroid/content/Intent;)V",
            &[(intent).into()],
        )?;
        Ok(())
    }

    /// True when the embedded engine's trampoline is part of this APK.
    pub fn has_embedded_engine() -> Result<bool, String> {
        with_env(|env, context| {
            let own = our_package(env, context)?;
            Ok(build_resolved_intent(env, context, &own, TRAMPOLINE, &[])?.is_some())
        })
    }

    pub fn is_moonlight_available() -> Result<bool, String> {
        with_env(|env, context| {
            let own = our_package(env, context)?;
            if build_resolved_intent(env, context, &own, TRAMPOLINE, &[])?.is_some() {
                return Ok(true);
            }
            Ok(build_resolved_intent(env, context, MOONLIGHT_PACKAGE, TRAMPOLINE, &[])?.is_some())
        })
    }

    /// Opens the engine's PC list UI (used during the one-time pairing flow).
    pub fn open_moonlight() -> Result<(), String> {
        with_env(|env, context| {
            let own = our_package(env, context)?;
            for package in [own.as_str(), MOONLIGHT_PACKAGE] {
                if let Some(intent) = build_resolved_intent(env, context, package, PC_VIEW, &[])? {
                    return start(env, context, &intent);
                }
            }
            Err(jni::errors::Error::JavaException)
        })
    }

    /// Fires the ShortcutTrampoline: with `app_name` it launches the stream
    /// directly; without it, it opens the PC's app list. Embedded engine
    /// first, external Moonlight app as fallback.
    pub fn launch_stream(pc_name: &str, app_name: Option<&str>) -> Result<(), String> {
        with_env(|env, context| {
            let mut extras: Vec<(&str, &str)> = vec![("Name", pc_name)];
            if let Some(app) = app_name {
                extras.push(("AppName", app));
            }
            let own = our_package(env, context)?;
            for package in [own.as_str(), MOONLIGHT_PACKAGE] {
                if let Some(intent) =
                    build_resolved_intent(env, context, package, TRAMPOLINE, &extras)?
                {
                    return start(env, context, &intent);
                }
            }
            Err(jni::errors::Error::JavaException)
        })
    }

    /// Reads the current activity intent's data URI directly — a fallback
    /// for when the deep-link plugin fails to surface a callback that the
    /// OS definitely delivered to the (singleTask) activity.
    pub fn current_intent_data() -> Result<Option<String>, String> {
        with_env(|env, context| {
            // The ndk-context context is the Activity on Tauri Android;
            // getIntent only exists on Activity — if this is an Application
            // context, the call errors and we return None gracefully.
            let intent = match env.call_method(
                context,
                "getIntent",
                "()Landroid/content/Intent;",
                &[],
            ) {
                Ok(v) => match v.l() {
                    Ok(obj) => obj,
                    Err(_) => return Ok(None),
                },
                Err(_) => {
                    // Clear the pending JavaException so later JNI calls work
                    let _ = env.exception_clear();
                    return Ok(None);
                }
            };
            if intent.is_null() {
                return Ok(None);
            }
            let data = env
                .call_method(&intent, "getDataString", "()Ljava/lang/String;", &[])?
                .l()?;
            if data.is_null() {
                return Ok(None);
            }
            let data: JString = data.into();
            let java_str = env.get_string(&data)?;
            let url = String::from(java_str);
            Ok(Some(url))
        })
    }

    /// Why did this app's processes last die? (API 30+) Returns human-readable
    /// entries: "<process> reason=<code:name> <description> @<time>".
    /// The definitive crash evidence when adb isn't available.
    pub fn last_exit_reasons() -> Result<Vec<String>, String> {
        fn reason_name(code: i32) -> &'static str {
            match code {
                1 => "EXIT_SELF",
                2 => "SIGNALED",
                3 => "LOW_MEMORY",
                4 => "JAVA_CRASH",
                5 => "NATIVE_CRASH",
                6 => "ANR",
                7 => "INITIALIZATION_FAILURE",
                8 => "PERMISSION_CHANGE",
                9 => "EXCESSIVE_RESOURCE_USAGE",
                10 => "USER_REQUESTED",
                11 => "USER_STOPPED",
                12 => "DEPENDENCY_DIED",
                13 => "OTHER",
                14 => "FREEZER",
                _ => "UNKNOWN",
            }
        }
        with_env(|env, context| {
            let svc = env.new_string("activity")?;
            let am = env
                .call_method(
                    context,
                    "getSystemService",
                    "(Ljava/lang/String;)Ljava/lang/Object;",
                    &[(&svc).into()],
                )?
                .l()?;
            let pkg_obj = env
                .call_method(context, "getPackageName", "()Ljava/lang/String;", &[])?
                .l()?;
            let list = env
                .call_method(
                    am,
                    "getHistoricalProcessExitReasons",
                    "(Ljava/lang/String;II)Ljava/util/List;",
                    &[(&pkg_obj).into(), JValue::Int(0), JValue::Int(4)],
                )?
                .l()?;
            let size = env.call_method(&list, "size", "()I", &[])?.i()?;
            let mut out = Vec::new();
            for i in 0..size.min(4) {
                let info = env
                    .call_method(&list, "get", "(I)Ljava/lang/Object;", &[JValue::Int(i)])?
                    .l()?;
                let reason = env.call_method(&info, "getReason", "()I", &[])?.i()?;
                let ts = env.call_method(&info, "getTimestamp", "()J", &[])?.j()?;
                let proc_name = {
                    let o = env
                        .call_method(&info, "getProcessName", "()Ljava/lang/String;", &[])?
                        .l()?;
                    if o.is_null() {
                        String::new()
                    } else {
                        let js: JString = o.into();
                        let s = env.get_string(&js)?;
                        String::from(s)
                    }
                };
                let desc = {
                    let o = env
                        .call_method(&info, "getDescription", "()Ljava/lang/String;", &[])?
                        .l()?;
                    if o.is_null() {
                        String::new()
                    } else {
                        let js: JString = o.into();
                        let s = env.get_string(&js)?;
                        String::from(s)
                    }
                };
                out.push(format!(
                    "{} reason={}:{} {} @{}",
                    proc_name,
                    reason,
                    reason_name(reason),
                    desc,
                    ts
                ));
            }
            Ok(out)
        })
    }

    /// Opens a URL in the system browser / matching app via ACTION_VIEW.
    pub fn open_url(url: &str) -> Result<(), String> {
        with_env(|env, context| {
            let uri_class = env.find_class("android/net/Uri")?;
            let url_str = env.new_string(url)?;
            let uri = env
                .call_static_method(
                    uri_class,
                    "parse",
                    "(Ljava/lang/String;)Landroid/net/Uri;",
                    &[(&url_str).into()],
                )?
                .l()?;

            let intent_class = env.find_class("android/content/Intent")?;
            let action = env.new_string("android.intent.action.VIEW")?;
            let intent = env.new_object(
                intent_class,
                "(Ljava/lang/String;Landroid/net/Uri;)V",
                &[(&action).into(), (&uri).into()],
            )?;
            env.call_method(
                &intent,
                "addFlags",
                "(I)Landroid/content/Intent;",
                &[JValue::Int(FLAG_ACTIVITY_NEW_TASK)],
            )?;
            start(env, context, &intent)
        })
    }
}

/// Opens a URL via ACTION_VIEW — used by the shared `open_url` command.
#[cfg(target_os = "android")]
pub fn android_open_url(url: &str) -> Result<(), String> {
    android::open_url(url)
}

/// Historical process-exit reasons (why did the app last die). Android only.
#[tauri::command]
pub fn get_last_exit_reasons() -> Result<Vec<String>, String> {
    #[cfg(target_os = "android")]
    {
        android::last_exit_reasons()
    }
    #[cfg(not(target_os = "android"))]
    {
        Ok(Vec::new())
    }
}

/// Raw current-intent data URI (deep-link plugin bypass).
#[tauri::command]
pub fn get_intent_data() -> Result<Option<String>, String> {
    #[cfg(target_os = "android")]
    {
        android::current_intent_data()
    }
    #[cfg(not(target_os = "android"))]
    {
        Ok(None)
    }
}

#[tauri::command]
pub fn is_moonlight_installed() -> Result<bool, String> {
    #[cfg(target_os = "android")]
    {
        android::is_moonlight_available()
    }
    #[cfg(not(target_os = "android"))]
    {
        Ok(false)
    }
}

/// True when the streaming engine ships inside this APK (no external
/// Moonlight app needed). The mobile UI uses this to skip the install step.
#[tauri::command]
pub fn has_embedded_engine() -> Result<bool, String> {
    #[cfg(target_os = "android")]
    {
        android::has_embedded_engine()
    }
    #[cfg(not(target_os = "android"))]
    {
        Ok(false)
    }
}

#[tauri::command]
pub fn open_moonlight_app() -> Result<(), String> {
    #[cfg(target_os = "android")]
    {
        android::open_moonlight()
    }
    #[cfg(not(target_os = "android"))]
    {
        Err("Only available on Android".into())
    }
}

#[tauri::command]
pub fn launch_moonlight_stream(pc_name: String, app_name: Option<String>) -> Result<(), String> {
    #[cfg(target_os = "android")]
    {
        android::launch_stream(&pc_name, app_name.as_deref())
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = (pc_name, app_name);
        Err("Only available on Android".into())
    }
}
