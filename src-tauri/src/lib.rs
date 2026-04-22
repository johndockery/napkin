//! napkin UI core. Thin client over the napkind unix-socket daemon.

mod client;
mod commands;
mod events;

use tauri::Manager;

use crate::client::{start_client, Client};
use crate::commands::{pty_kill, pty_resize, pty_spawn, pty_write};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let handle = app.handle().clone();
            match start_client(handle) {
                Ok(client) => {
                    app.manage(client);
                }
                Err(error) => {
                    eprintln!("napkin: failed to connect to napkind: {error}");
                    // Keep the invoke surface available so the frontend gets a
                    // clean error instead of a missing state panic.
                    app.manage(Client::disconnected());
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            pty_spawn, pty_write, pty_resize, pty_kill,
        ])
        .run(tauri::generate_context!())
        .expect("error while running napkin");
}
