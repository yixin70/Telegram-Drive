//! Keep each command's argument parsing and async-future construction off the
//! shared dispatcher frame. Tauri's IIFE wrappers can be inlined together in an
//! optimized build, exhausting the Windows UI thread's stack before any await.
macro_rules! bounded_handler {
    ($($(#[$attribute:meta])* $($path:ident)::+),* $(,)?) => {{
        move |invoke: tauri::ipc::Invoke<tauri::Wry>| {
            match invoke.message.command() {
                $(
                    $(#[$attribute])*
                    $crate::ipc_dispatch::bounded_handler!(@name $($path)::+) => {
                        // A real call boundary is essential: an ordinary closure or
                        // helper without inline(never) recreates the original frame.
                        #[inline(never)]
                        fn dispatch(invoke: tauri::ipc::Invoke<tauri::Wry>) -> bool {
                            let handler: fn(tauri::ipc::Invoke<tauri::Wry>) -> bool =
                                tauri::generate_handler![$($path)::+];
                            handler(invoke)
                        }
                        dispatch(invoke)
                    },
                )*
                _ => false,
            }
        }
    }};
    (@name $head:ident::$($tail:ident)::+) => {
        $crate::ipc_dispatch::bounded_handler!(@name $($tail)::+)
    };
    (@name $command:ident) => { stringify!($command) };
}

// The registration list uses Rust command names (no command-level renames).
// The real Tauri wrapper still owns argument extraction, ACLs and responses.
pub(crate) use bounded_handler;
