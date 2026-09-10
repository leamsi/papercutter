mod completion;
mod history;
mod picker;
mod plain;
mod state;
mod transport;
mod ui;
mod value;

pub use picker::prepare as prepare_connection;
pub use plain::is_incomplete;

use std::io::IsTerminal;

use crate::conn::SpaceConnection;

pub fn run(conn: SpaceConnection) -> Result<(), String> {
    run_with_options(conn, false)
}

pub fn run_with_options(conn: SpaceConnection, plain: bool) -> Result<(), String> {
    if plain || !std::io::stdin().is_terminal() || !std::io::stdout().is_terminal() {
        plain::run(conn)
    } else {
        ui::run(conn)
    }
}
