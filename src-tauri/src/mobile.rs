// Android bridge to the Moonlight client app (com.limelight).
//
// Uses JNI directly against the Android context that Tauri/wry register via
// ndk-context — no separate plugin crate needed. Moonlight officially
// supports being launched by other apps through its ShortcutTrampoline
// activity (extras: Name / UUID / AppId / AppName).

#[cfg(target_os = "android")]
mod android {
    use jni::objects::{JObject, JValue};

    const MOONLIGHT_PACKAGE: &str = "com.limelight";
    const TRAMPOLINE: &str = "com.limelight.ShortcutTrampoline";
    const FLAG_ACTIVITY_NEW_TASK: i32 = 0x1000_0000;

    fn with_env<T>(
        f: impl FnOnce(&mut jni::JNIEnv, &JObject) -> Result<T, jni::errors::Error>,
    ) -> Result<T, String> {
        let ctx = ndk_context::android_context();
        let vm = unsafe { jni::JavaVM::from_raw(ctx.vm().cast()) }.map_err(|e| e.to_string())?;
        let mut env = vm.attach_current_thread().map_err(|e| e.to_string())?;
        let context = unsafe { JObject::from_raw(ctx.context().cast()) };
        f(&mut env, &context).map_err(|e| e.to_string())
    }

    pub fn is_moonlight_installed() -> Result<bool, String> {
        with_env(|env, context| {
            let pm = env
                .call_method(
                    context,
                    "getPackageManager",
                    "()Landroid/content/pm/PackageManager;",
                    &[],
                )?
                .l()?;
            let pkg = env.new_string(MOONLIGHT_PACKAGE)?;
            let launch_intent = env
                .call_method(
                    pm,
                    "getLaunchIntentForPackage",
                    "(Ljava/lang/String;)Landroid/content/Intent;",
                    &[(&pkg).into()],
                )?
                .l()?;
            Ok(!launch_intent.is_null())
        })
    }

    /// Opens Moonlight's main UI (used during the one-time pairing flow).
    pub fn open_moonlight() -> Result<(), String> {
        with_env(|env, context| {
            let pm = env
                .call_method(
                    context,
                    "getPackageManager",
                    "()Landroid/content/pm/PackageManager;",
                    &[],
                )?
                .l()?;
            let pkg = env.new_string(MOONLIGHT_PACKAGE)?;
            let intent = env
                .call_method(
                    pm,
                    "getLaunchIntentForPackage",
                    "(Ljava/lang/String;)Landroid/content/Intent;",
                    &[(&pkg).into()],
                )?
                .l()?;
            if intent.is_null() {
                return Err(jni::errors::Error::JavaException);
            }
            env.call_method(
                &intent,
                "addFlags",
                "(I)Landroid/content/Intent;",
                &[JValue::Int(FLAG_ACTIVITY_NEW_TASK)],
            )?;
            env.call_method(
                context,
                "startActivity",
                "(Landroid/content/Intent;)V",
                &[(&intent).into()],
            )?;
            Ok(())
        })
    }

    /// Fires Moonlight's ShortcutTrampoline: with `app_name` it launches the
    /// stream directly; without it, it opens the PC's app list.
    pub fn launch_stream(pc_name: &str, app_name: Option<&str>) -> Result<(), String> {
        with_env(|env, context| {
            let intent_class = env.find_class("android/content/Intent")?;
            let intent = env.new_object(intent_class, "()V", &[])?;

            let pkg = env.new_string(MOONLIGHT_PACKAGE)?;
            let cls = env.new_string(TRAMPOLINE)?;
            env.call_method(
                &intent,
                "setClassName",
                "(Ljava/lang/String;Ljava/lang/String;)Landroid/content/Intent;",
                &[(&pkg).into(), (&cls).into()],
            )?;

            let name_key = env.new_string("Name")?;
            let name_val = env.new_string(pc_name)?;
            env.call_method(
                &intent,
                "putExtra",
                "(Ljava/lang/String;Ljava/lang/String;)Landroid/content/Intent;",
                &[(&name_key).into(), (&name_val).into()],
            )?;

            if let Some(app) = app_name {
                let app_key = env.new_string("AppName")?;
                let app_val = env.new_string(app)?;
                env.call_method(
                    &intent,
                    "putExtra",
                    "(Ljava/lang/String;Ljava/lang/String;)Landroid/content/Intent;",
                    &[(&app_key).into(), (&app_val).into()],
                )?;
            }

            env.call_method(
                &intent,
                "addFlags",
                "(I)Landroid/content/Intent;",
                &[JValue::Int(FLAG_ACTIVITY_NEW_TASK)],
            )?;
            env.call_method(
                context,
                "startActivity",
                "(Landroid/content/Intent;)V",
                &[(&intent).into()],
            )?;
            Ok(())
        })
    }
}

/// Opens a URL in the system browser / matching app via ACTION_VIEW.
/// Used by the shared `open_url` command (desktop shells out instead).
#[cfg(target_os = "android")]
pub fn android_open_url(url: &str) -> Result<(), String> {
    use jni::objects::{JObject, JValue};
    let ctx = ndk_context::android_context();
    let vm = unsafe { jni::JavaVM::from_raw(ctx.vm().cast()) }.map_err(|e| e.to_string())?;
    let mut env = vm.attach_current_thread().map_err(|e| e.to_string())?;
    let context = unsafe { JObject::from_raw(ctx.context().cast()) };

    (|| -> Result<(), jni::errors::Error> {
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
            &[JValue::Int(0x1000_0000)],
        )?;
        env.call_method(
            context,
            "startActivity",
            "(Landroid/content/Intent;)V",
            &[(&intent).into()],
        )?;
        Ok(())
    })()
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn is_moonlight_installed() -> Result<bool, String> {
    #[cfg(target_os = "android")]
    {
        android::is_moonlight_installed()
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
