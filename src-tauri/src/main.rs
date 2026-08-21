// V release buildu neotvírat konzolové okno vedle aplikace.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    opsys_lib::run();
}
