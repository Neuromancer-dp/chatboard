fn main() {
    // let install-desktop bake in where the checkout and node live
    println!("cargo:rerun-if-env-changed=CHATBOARD_DIR");
    println!("cargo:rerun-if-env-changed=CHATBOARD_NODE");
    tauri_build::build()
}
