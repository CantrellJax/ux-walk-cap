use std::io::Read as _;

use clap::{Args, Subcommand};
use serde_json::json;

use crate::write_json;

#[derive(Args)]
pub struct SharingArgs {
    #[command(subcommand)]
    command: SharingCommand,
}

#[derive(Subcommand)]
enum SharingCommand {
    Status,
    Configure {
        #[arg(long)]
        server: Option<String>,
        #[arg(long, conflicts_with = "disable")]
        enable: bool,
        #[arg(long)]
        disable: bool,
        #[arg(long)]
        expires_in_days: Option<u32>,
        #[arg(long)]
        token_stdin: bool,
    },
    Revoke {
        id: String,
    },
}

impl SharingArgs {
    pub async fn run(self) -> Result<(), String> {
        match self.command {
            SharingCommand::Status => {
                let settings = cap_cloud_sharing::load()?;
                write_json(
                    &json!({ "enabled": settings.enabled, "server": settings.endpoint, "expiresInDays": settings.expires_in_days }),
                )
            }
            SharingCommand::Configure {
                server,
                enable,
                disable,
                expires_in_days,
                token_stdin,
            } => {
                let mut settings = cap_cloud_sharing::load()?;
                if let Some(server) = server {
                    settings.endpoint = cap_cloud_sharing::endpoint(&server)?
                        .origin()
                        .ascii_serialization();
                }
                if enable {
                    settings.enabled = true;
                }
                if disable {
                    settings.enabled = false;
                }
                if let Some(days) = expires_in_days {
                    settings.expires_in_days = days;
                }
                if token_stdin {
                    let mut token = String::new();
                    std::io::stdin()
                        .take(4097)
                        .read_to_string(&mut token)
                        .map_err(|_| "Could not read the upload credential.")?;
                    if token.len() > 4096 {
                        return Err("Upload credential is too long.".into());
                    }
                    cap_cloud_sharing::set_token(&settings.endpoint, &token)?;
                }
                cap_cloud_sharing::save(&settings)?;
                write_json(
                    &json!({ "saved": true, "enabled": settings.enabled, "server": settings.endpoint }),
                )
            }
            SharingCommand::Revoke { id } => {
                cap_cloud_sharing::SharingClient::configured()?
                    .revoke(&id)
                    .await?;
                write_json(&json!({ "id": id, "revoked": true }))
            }
        }
    }
}
