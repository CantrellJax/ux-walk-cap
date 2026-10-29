use clap::{Args, Subcommand};
use serde_json::json;
use std::{
    io::{Read as _, Write as _},
    path::PathBuf,
};

#[derive(Args)]
pub struct RecoveryArgs {
    #[command(subcommand)]
    command: RecoveryCommand,
}
#[derive(Subcommand)]
enum RecoveryCommand {
    Status,
    Request {
        #[arg(long)]
        server_origin: String,
        #[arg(long)]
        method: String,
        #[arg(long)]
        resource: String,
        #[arg(long)]
        input: Option<PathBuf>,
        #[arg(long)]
        output: Option<PathBuf>,
    },
}
impl RecoveryArgs {
    pub async fn run(self) -> Result<(), String> {
        match self.command {
            RecoveryCommand::Status => {
                let settings = cap_cloud_sharing::load()?;
                crate::write_json(
                    &json!({ "backupEnabled": settings.backup_enabled, "server": settings.endpoint, "expiresInDays": settings.expires_in_days }),
                )
            }
            RecoveryCommand::Request {
                server_origin,
                method,
                resource,
                input,
                output,
            } => {
                let client = cap_cloud_sharing::SharingClient::configured_recovery(
                    &server_origin,
                    method == "PUT",
                )?;
                let body = if let Some(file) = input {
                    let mut bytes = Vec::new();
                    std::fs::File::open(file)
                        .map_err(|_| "Could not open the local recovery object.")?
                        .take(cap_cloud_sharing::recovery::RECOVERY_OBJECT_LIMIT as u64 + 1)
                        .read_to_end(&mut bytes)
                        .map_err(|_| "Could not read the local recovery object.")?;
                    if bytes.len() > cap_cloud_sharing::recovery::RECOVERY_OBJECT_LIMIT {
                        return Err("Recovery object exceeds eight MiB.".into());
                    }
                    Some(bytes)
                } else {
                    None
                };
                let (status, bytes) = client.recovery_request(&method, &resource, body).await?;
                if let Some(file) = output {
                    let parent = file
                        .parent()
                        .ok_or("Recovery output needs a parent directory.")?;
                    std::fs::create_dir_all(parent)
                        .map_err(|_| "Could not create recovery output directory.")?;
                    let temporary = file.with_extension(format!(
                        "{}-{}.tmp",
                        std::process::id(),
                        uuid::Uuid::new_v4()
                    ));
                    let result = (|| -> Result<(), String> {
                        let mut options = std::fs::OpenOptions::new();
                        options.create_new(true).write(true);
                        #[cfg(unix)]
                        {
                            use std::os::unix::fs::OpenOptionsExt as _;
                            options.mode(0o600);
                        }
                        let mut target = options
                            .open(&temporary)
                            .map_err(|_| "Could not stage recovery download.")?;
                        target
                            .write_all(&bytes)
                            .and_then(|()| target.sync_all())
                            .map_err(|_| "Could not save recovery download.")?;
                        std::fs::rename(&temporary, &file)
                            .map_err(|_| "Could not publish recovery download.")?;
                        #[cfg(unix)]
                        {
                            std::fs::File::open(parent)
                                .and_then(|directory| directory.sync_all())
                                .map_err(
                                    |_| "Could not synchronize recovery download directory.",
                                )?;
                        }
                        Ok(())
                    })();
                    if result.is_err() {
                        let _ = std::fs::remove_file(temporary);
                    }
                    result?;
                    crate::write_json(&json!({ "status": status, "bytes": bytes.len() }))
                } else if bytes.is_empty() {
                    crate::write_json(&json!({ "status": status }))
                } else {
                    let value: serde_json::Value = serde_json::from_slice(&bytes)
                        .map_err(|_| "Recovery server returned invalid JSON.")?;
                    crate::write_json(&value)
                }
            }
        }
    }
}
