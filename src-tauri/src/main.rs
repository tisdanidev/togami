// Togami desktop (Windows, macOS). Everything is in lib.rs, which Android
// also starts from.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    togami_lib::run()
}
