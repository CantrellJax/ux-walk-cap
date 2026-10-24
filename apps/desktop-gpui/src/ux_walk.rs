use std::process::{Command, Stdio};

pub use crate::ux_walk_preferences::*;

pub fn start(cx: &mut gpui::App) {
    let helper = std::env::current_exe()
        .ok()
        .and_then(|executable| Some(executable.parent()?.parent()?.join("Helpers/UX Walk.app")));
    let Some(helper) = helper.filter(|path| path.is_dir()) else {
        cx.open_url("ux-walk://start?capture=cap");
        return;
    };
    cx.spawn(async move |cx| {
        let opened = cx.background_executor().spawn(async move {
            Command::new("/usr/bin/open")
                .arg("-a")
                .arg(helper)
                .arg("ux-walk://start?capture=cap")
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status()
                .is_ok_and(|status| status.success())
        }).await;
        if !opened {
            crate::platform::alert_dialog("Cap-UX", "The bundled UX Walk helper could not open. Reinstall this Cap-UX build and try again.");
        }
    }).detach();
}

#[cfg(target_os = "macos")]
pub fn prompt_key(label: &str) -> Option<String> {
    use objc2::{
        class, msg_send, msg_send_id,
        rc::{Allocated, Id},
        runtime::AnyObject,
    };
    use objc2_foundation::{NSPoint, NSRect, NSSize, NSString};
    unsafe {
        let alert: Id<AnyObject> = msg_send_id![class!(NSAlert), new];
        let field: Allocated<AnyObject> = msg_send_id![class!(NSSecureTextField), alloc];
        let field: Id<AnyObject> = msg_send_id![field, initWithFrame: NSRect::new(NSPoint::new(0., 0.), NSSize::new(320., 24.))];
        let _: () =
            msg_send![&*alert, setMessageText: &*NSString::from_str(&format!("{label} API key"))];
        let _: () = msg_send![&*alert, setInformativeText: &*NSString::from_str("Saved in your login Keychain for UX Walk. Your audio is sent to this provider when transcription runs.")];
        let _: () = msg_send![&*alert, setAccessoryView: &*field];
        let _: *mut AnyObject =
            msg_send![&*alert, addButtonWithTitle: &*NSString::from_str("Save Key")];
        let _: *mut AnyObject =
            msg_send![&*alert, addButtonWithTitle: &*NSString::from_str("Cancel")];
        let window: *mut AnyObject = msg_send![&*alert, window];
        let _: objc2::runtime::Bool = msg_send![window, makeFirstResponder: &*field];
        let response: isize = msg_send![&*alert, runModal];
        if response != 1000 {
            return None;
        }
        let value: Id<NSString> = msg_send_id![&*field, stringValue];
        Some(value.to_string())
    }
}

#[cfg(not(target_os = "macos"))]
pub fn prompt_key(_label: &str) -> Option<String> {
    None
}
