use std::sync::LazyLock;

use serde::{Deserialize, Serialize};
use tokio::sync::broadcast;

#[derive(Clone, Serialize, Deserialize, Debug)]
pub struct DbEvent {
    pub table: String,
    pub action: String,
    pub id: serde_json::Value,
}

pub static DB_EVENT_SENDER: LazyLock<broadcast::Sender<DbEvent>> = LazyLock::new(|| {
    let (tx, _) = broadcast::channel(100);
    tx
});

pub fn emit_event(table: &str, action: &str, id: serde_json::Value) {
    let _ = DB_EVENT_SENDER.send(DbEvent {
        table: table.to_string(),
        action: action.to_string(),
        id,
    });
}
