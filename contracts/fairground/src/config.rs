//! Configuration fixed at deploy time. Nothing can change it later.

use near_sdk::{AccountId, near};

use crate::Error;

/// The pinned OutLayer job. Serialises exactly as OutLayer's `ExecutionSource`
/// (`{"Project":{..}}` / `{"WasmUrl":{..}}`). A project version is always
/// named: `version_key: null` would run whatever version the project owner
/// activates, so it cannot be expressed here.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SealerSource {
    Project {
        project_id: String,
        /// The version's wasm sha256 (hex), equal to `sealer_code_hash`.
        version_key: String,
    },
    WasmUrl {
        url: String,
        /// The wasm sha256 (hex), equal to `sealer_code_hash`.
        hash: String,
        build_target: Option<String>,
    },
}

/// OutLayer `secrets_ref`: the secrets row the sealer reads its master key from.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SecretsRef {
    pub profile: String,
    pub account_id: AccountId,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Config {
    /// OutLayer contract (`outlayer.testnet` / `outlayer.near`).
    pub outlayer: AccountId,
    pub sealer_source: SealerSource,
    /// The pinned sealer wasm sha256, lowercase hex. Copied into every sale.
    pub sealer_code_hash: String,
    pub sealer_secrets: Option<SecretsRef>,
    /// Quote tokens (USDC contracts) a sale may use.
    pub allowed_quote_tokens: Vec<AccountId>,
    /// The Rhea (Ref) exchange that launch pools are seeded on
    /// (`ref-finance-101.testnet` / `v2.ref-finance.near`). `None` turns
    /// launch liquidity off: `create_sale` then refuses `liquidity`.
    pub dex: Option<AccountId>,
}

impl Config {
    pub(crate) fn validate(&self) -> Result<(), Error> {
        if !is_lower_hex(&self.sealer_code_hash, 64) {
            return Err(Error::InvalidConfig(
                "sealer_code_hash must be 64 lowercase hex characters",
            ));
        }
        match &self.sealer_source {
            SealerSource::Project {
                project_id,
                version_key,
            } => {
                if !project_id.contains('/') || project_id.len() > 128 {
                    return Err(Error::InvalidConfig(
                        "Project project_id must look like <owner>/<name>",
                    ));
                }
                if *version_key != self.sealer_code_hash {
                    return Err(Error::InvalidConfig(
                        "Project version_key must equal sealer_code_hash",
                    ));
                }
            }
            SealerSource::WasmUrl { url, hash, .. } => {
                if !url.starts_with("https://")
                    || url.len() > 2048
                    || url.contains(char::is_whitespace)
                {
                    return Err(Error::InvalidConfig(
                        "WasmUrl url must be an https:// URL of at most 2048 bytes",
                    ));
                }
                if *hash != self.sealer_code_hash {
                    return Err(Error::InvalidConfig(
                        "WasmUrl hash must equal sealer_code_hash",
                    ));
                }
            }
        }
        if let Some(secrets) = &self.sealer_secrets {
            // OutLayer refuses any other profile name before running anything.
            let valid = (1..=64).contains(&secrets.profile.len())
                && secrets
                    .profile
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_');
            if !valid {
                return Err(Error::InvalidConfig(
                    "sealer_secrets.profile must be 1-64 letters, digits, '-' or '_'",
                ));
            }
        }
        if self.allowed_quote_tokens.is_empty() {
            return Err(Error::InvalidConfig(
                "allowed_quote_tokens must not be empty",
            ));
        }
        for (i, token) in self.allowed_quote_tokens.iter().enumerate() {
            if self.allowed_quote_tokens[..i].contains(token) {
                return Err(Error::InvalidConfig("allowed_quote_tokens has a duplicate"));
            }
        }
        if let Some(dex) = &self.dex
            && (*dex == self.outlayer || self.allows_quote_token(dex))
        {
            return Err(Error::InvalidConfig(
                "dex must not be the OutLayer contract or a quote token",
            ));
        }
        Ok(())
    }

    pub(crate) fn allows_quote_token(&self, token: &AccountId) -> bool {
        self.allowed_quote_tokens.contains(token)
    }
}

/// `len` lowercase hex digits.
pub(crate) fn is_lower_hex(s: &str, len: usize) -> bool {
    s.len() == len && s.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}
